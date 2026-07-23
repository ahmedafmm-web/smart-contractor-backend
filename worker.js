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

      const PAYMOB_SECRET_KEY = (env.PAYMOB_SECRET_KEY || "").trim();
      const PAYMOB_PUBLIC_KEY = (env.PAYMOB_PUBLIC_KEY || "").trim();
      const SUPABASE_URL = (env.SUPABASE_URL || "").trim().replace(/\/$/, "");
      const SUPABASE_SERVICE_ROLE_KEY = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

      // 1. التفعيل التجريبي لمدة 48 ساعة مع كشف الأخطاء التفصيلية
      if (body.action === "activate_trial") {
        const { device_id } = body;

        if (!device_id) {
          return new Response(JSON.stringify({
            success: false,
            message: "يرجى اختيار وإدخال كود الجهاز."
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // التأكد من وجود إعدادات Supabase
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
          return new Response(JSON.stringify({
            success: false,
            message: "خطأ: متغيرا SUPABASE_URL أو SUPABASE_SERVICE_ROLE_KEY غير معرفين في Cloudflare Variables."
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const trialExpiry = new Date();
        trialExpiry.setHours(trialExpiry.getHours() + 48);

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
            status: "trial",
            expires_at: trialExpiry.toISOString(),
            updated_at: new Date().toISOString()
          })
        });

        // قراءة استجابة Supabase بالكامل لكشف الخطأ الدقيق
        const resText = await supabaseRes.text();

        if (supabaseRes.ok) {
          return new Response(JSON.stringify({
            success: true,
            message: `تم تفعيل التجربة المجانية لمدة 48 ساعة بنجاح للجهاز: ${device_id}`,
            trial_expires_at: trialExpiry.toISOString()
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } else {
          return new Response(JSON.stringify({
            success: false,
            message: `خطأ Supabase (${supabaseRes.status}): ${resText}`
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      if (!PAYMOB_SECRET_KEY || !PAYMOB_PUBLIC_KEY) {
        return new Response(JSON.stringify({
          success: false,
          message: "خطأ: مفاتيح Paymob غير معرفة في إعدادات Cloudflare Variables."
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 2. إنشاء جلسة الدفع (Payment Intent / Intention)
      if (body.action === "create_payment_intent") {
        const planType = body.plan_type || "monthly";
        const deviceId = body.device_id || "UNKNOWN";
        const amountCents = (planType === "yearly") ? 200000 : 25000;

        const CARD_INTEGRATION_ID = 5790552;
        const WALLET_INTEGRATION_ID = 5783298;

        const paymobIntentRes = await fetch("https://accept.paymob.com/v1/intention/", {
          method: "POST",
          headers: {
            "Authorization": `Secret ${PAYMOB_SECRET_KEY}`,
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

        const contentType = paymobIntentRes.headers.get("content-type") || "";

        if (!contentType.includes("application/json")) {
          const rawText = await paymobIntentRes.text();
          return new Response(JSON.stringify({
            success: false,
            message: `استجابة سيرفر Paymob (${paymobIntentRes.status}): ${rawText.substring(0, 100)}`
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const intentData = await paymobIntentRes.json();
        const clientSecret = intentData.client_secret || intentData.cs;

        if (paymobIntentRes.ok && clientSecret) {
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

      // 3. التحقق والتفعيل المالي
      if (body.action === "verify_payment") {
        const { transaction_id, device_id } = body;

        if (!transaction_id || !device_id) {
          return new Response(JSON.stringify({
            success: false,
            message: "يرجى إدخال رقم العملية واختيار كود الجهاز."
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        let authToken = "";
        try {
          const authRes = await fetch("https://accept.paymob.com/api/auth/tokens", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: PAYMOB_SECRET_KEY })
          });
          if (authRes.ok) {
            const authData = await authRes.json();
            authToken = authData.token;
          }
        } catch (e) {
          console.error("Auth token fetch failed, falling back to Secret/Token");
        }

        const verifyRes = await fetch(`https://accept.paymob.com/api/acceptance/transactions/${transaction_id}`, {
          method: "GET",
          headers: {
            "Authorization": authToken ? `Bearer ${authToken}` : `Token ${PAYMOB_SECRET_KEY}`,
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

          const resText = await supabaseRes.text();

          if (supabaseRes.ok) {
            return new Response(JSON.stringify({
              success: true,
              message: `تم التفعيل بنجاح! ينتهي اشتراكك في: ${expiryDate.toLocaleDateString('ar-EG')}`,
              expires_at: expiryDate.toISOString()
            }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          } else {
            return new Response(JSON.stringify({
              success: false,
              message: `خطأ Supabase (${supabaseRes.status}): ${resText}`
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
