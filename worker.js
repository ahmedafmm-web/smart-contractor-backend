export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const body = await request.json();

      const PAYMOB_SECRET_KEY = env.PAYMOB_SECRET_KEY;
      const PAYMOB_PUBLIC_KEY = env.PAYMOB_PUBLIC_KEY;
      const SUPABASE_URL = (env.SUPABASE_URL || "").trim().replace(/\/$/, "");
      const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

      if (!PAYMOB_SECRET_KEY || !PAYMOB_PUBLIC_KEY) {
        return new Response(JSON.stringify({
          success: false,
          message: "خطأ: مفاتيح Paymob غير معرفة في إعدادات Cloudflare Variables."
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 1. إنشاء جلسة الدفع (Payment Intent)
      if (body.action === "create_payment_intent") {
        const planType = body.plan_type || "monthly";
        const deviceId = body.device_id || "UNKNOWN";
        const amountCents = (planType === "yearly") ? 200000 : 25000;

        const CARD_INTEGRATION_ID = 5790552;
        const WALLET_INTEGRATION_ID = 5783298;

        const paymobIntentRes = await fetch("https://accept.paymob.com/api/ecommerce/payment-intents", {
          method: "POST",
          headers: {
            "Authorization": `Token ${PAYMOB_SECRET_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            amount: amountCents,
            currency: "EGP",
            payment_methods: [CARD_INTEGRATION_ID, WALLET_INTEGRATION_ID],
            billing_data: {
              first_name: "Smart",
              last_name: "Contractor",
              email: "client@smartcontractor.com",
              phone_number: "+201000000000"
            },
            special_reference: `SC_${deviceId}_${Date.now()}`
          })
        });

        // التحقق من أن الرد JSON وليس HTML
        const contentType = paymobIntentRes.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          const rawText = await paymobIntentRes.text();
          return new Response(JSON.stringify({
            success: false,
            message: `استجابة غير متوقعة من Paymob (غير مقبولة): ${rawText.substring(0, 100)}`
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const intentData = await paymobIntentRes.json();

        if (paymobIntentRes.ok && intentData.client_secret) {
          const clientSecret = intentData.client_secret;
          const paymentUrl = `https://accept.paymob.com/unifiedcheckout/?publicKey=${PAYMOB_PUBLIC_KEY}&clientSecret=${clientSecret}`;
          
          return new Response(JSON.stringify({
            success: true,
            payment_url: paymentUrl
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } else {
          const errorDetails = intentData.detail || intentData.message || JSON.stringify(intentData);
          return new Response(JSON.stringify({
            success: false,
            message: `رفض Paymob: ${errorDetails}`
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      // 2. التحقق والتفعيل
      if (body.action === "verify_payment") {
        const { transaction_id, device_id } = body;

        if (!transaction_id || !device_id) {
          return new Response(JSON.stringify({
            success: false,
            message: "يرجى إدخال رقم العملية واختيار كود الجهاز."
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const verifyRes = await fetch(`https://accept.paymob.com/api/acceptance/transactions/${transaction_id}`, {
          method: "GET",
          headers: {
            "Authorization": `Token ${PAYMOB_SECRET_KEY}`,
            "Content-Type": "application/json"
          }
        });

        const contentType = verifyRes.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          return new Response(JSON.stringify({
            success: false,
            message: "تعذر الحصول على استجابة صحيحة من Paymob للتحقق."
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const txData = await verifyRes.json();

        if (txData.success && txData.pending === false) {
          const amountCents = txData.amount_cents;
          let daysToAdd = (amountCents >= 200000) ? 365 : 30;

          const expiryDate = new Date();
          expiryDate.setDate(expiryDate.getDate() + daysToAdd);

          const supabaseRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
            method: "POST",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "resolution=merge-duplicates"
            },
            body: JSON.stringify({
              device_id: device_id,
              status: "active",
              expires_at: expiryDate.toISOString(),
              last_transaction_id: String(transaction_id),
              updated_at: new Date().toISOString()
            })
          });

          if (supabaseRes.ok) {
            return new Response(JSON.stringify({
              success: true,
              message: `تم التفعيل بنجاح! ينتهي اشتراكك في: ${expiryDate.toLocaleDateString('ar-EG')}`
            }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          } else {
            return new Response(JSON.stringify({
              success: false,
              message: "تم التحقق من الدفع، ولكن حدث خطأ أثناء التحديث في Supabase."
            }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        } else {
          return new Response(JSON.stringify({
            success: false,
            message: "العملية لم تكتمل بنجاح أو ما زالت قيد الانتظار."
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      return new Response(JSON.stringify({ success: false, message: "Invalid Action" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    } catch (err) {
      return new Response(JSON.stringify({
        success: false,
        message: `خطأ في الـ Worker: ${err.message}`
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
