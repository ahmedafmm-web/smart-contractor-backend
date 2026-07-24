export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ success: false, message: "Method Not Allowed" }), {
          status: 405,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      let body = {};
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: "بيانات Request غير صحيحة" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // تنظيف المتغيرات تماماً من أي مسافات أو أسطر مخفية
      const PAYMOB_SECRET_KEY = (env.PAYMOB_SECRET_KEY || "").replace(/\s+/g, "");
      const PAYMOB_PUBLIC_KEY = (env.PAYMOB_PUBLIC_KEY || "").replace(/\s+/g, "");
      const SUPABASE_URL = (env.SUPABASE_URL || "").replace(/\s+/g, "").replace(/\/$/, "");
      const SUPABASE_SERVICE_ROLE_KEY = (env.SUPABASE_SERVICE_ROLE_KEY || "").replace(/\s+/g, "");

      // ----------------------------------------------------
      // 1. تفعيل التجربة المجانية (activate_trial)
      // ----------------------------------------------------
      if (body.action === "activate_trial") {
        const deviceId = body.device_id;
        if (!deviceId) {
          return new Response(JSON.stringify({
            success: false,
            message: "يرجى إدخال كود الجهاز لتفعيل التجربة."
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const expiryDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

        // ربط صريح يمنع كود 530 عن طريق إضافة on_conflict وتحديد الـ Headers بدقة
        const supabaseEndpoint = `${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=device_id`;

        const supabaseRes = await fetch(supabaseEndpoint, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=representation"
          },
          body: JSON.stringify([{
            device_id: deviceId,
            status: "trial",
            expires_at: expiryDate,
            updated_at: new Date().toISOString()
          }])
        });

        const resText = await supabaseRes.text();
        let parsedData;
        try { parsedData = JSON.parse(resText); } catch (e) { parsedData = resText; }

        if (supabaseRes.ok) {
          return new Response(JSON.stringify({
            success: true,
            message: `✅ تم تفعيل التجربة المجانية بنجاح لمدة 48 ساعة للجهاز: ${deviceId}`,
            trial_expires_at: expiryDate,
            data: parsedData
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } else {
          return new Response(JSON.stringify({
            success: false,
            message: `فشل الكتابة في Supabase (كود ${supabaseRes.status})`,
            details: parsedData
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      // ----------------------------------------------------
      // 2. إنشاء جلسة الدفع (create_payment_intent)
      // ----------------------------------------------------
      if (body.action === "create_payment_intent") {
        const planType = body.plan_type || "monthly";
        const deviceId = body.device_id || "UNKNOWN";
        const amountCents = (planType === "yearly") ? 200000 : 25000;

        const CARD_INTEGRATION_ID = 5790552;
        const WALLET_INTEGRATION_ID = 5783298;

        let authHeader = PAYMOB_SECRET_KEY.startsWith("Egy_sk_") 
          ? `Bearer ${PAYMOB_SECRET_KEY}` 
          : `Secret ${PAYMOB_SECRET_KEY}`;

        let paymobRes = await fetch("https://accept.paymob.com/v1/intention/", {
          method: "POST",
          headers: {
            "Authorization": authHeader,
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

        if (paymobRes.status === 401 || paymobRes.status === 403) {
          paymobRes = await fetch("https://accept.paymob.com/v1/intention/", {
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
        }

        const rawText = await paymobRes.text();
        let intentData;
        try { intentData = JSON.parse(rawText); } catch (e) { intentData = rawText; }

        if (paymobRes.ok && intentData.client_secret) {
          const paymentUrl = `https://accept.paymob.com/unifiedcheckout/?publicKey=${PAYMOB_PUBLIC_KEY}&clientSecret=${intentData.client_secret}`;
          return new Response(JSON.stringify({
            success: true,
            payment_url: paymentUrl
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } else {
          return new Response(JSON.stringify({
            success: false,
            message: `رفض Paymob: ${JSON.stringify(intentData)}`
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      // ----------------------------------------------------
      // 3. التحقق والتفعيل اليدوي (verify_payment)
      // ----------------------------------------------------
      if (body.action === "verify_payment") {
        const { transaction_id, device_id } = body;

        if (!transaction_id || !device_id) {
          return new Response(JSON.stringify({
            success: false,
            message: "يرجى إدخال رقم العملية وكود الجهاز."
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
        } catch (e) {}

        const verifyRes = await fetch(`https://accept.paymob.com/api/acceptance/transactions/${transaction_id}`, {
          method: "GET",
          headers: {
            "Authorization": authToken ? `Bearer ${authToken}` : `Token ${PAYMOB_SECRET_KEY}`,
            "Content-Type": "application/json"
          }
        });

        const rawTxText = await verifyRes.text();
        let txData;
        try { txData = JSON.parse(rawTxText); } catch (e) { txData = rawTxText; }

        if (verifyRes.ok && txData.success && txData.pending === false) {
          const amountCents = txData.amount_cents;
          let daysToAdd = (amountCents >= 200000) ? 365 : 30;

          const expiryDate = new Date();
          expiryDate.setDate(expiryDate.getDate() + daysToAdd);

          const supabaseEndpoint = `${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=device_id`;

          const supabaseRes = await fetch(supabaseEndpoint, {
            method: "POST",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "resolution=merge-duplicates"
            },
            body: JSON.stringify([{
              device_id: device_id,
              status: "active",
              expires_at: expiryDate.toISOString(),
              last_transaction_id: String(transaction_id),
              updated_at: new Date().toISOString()
            }])
          });

          if (supabaseRes.ok) {
            return new Response(JSON.stringify({
              success: true,
              message: `تم التفعيل بنجاح! ينتهي اشتراكك في: ${expiryDate.toLocaleDateString('ar-EG')}`
            }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          } else {
            const errBody = await supabaseRes.text();
            return new Response(JSON.stringify({
              success: false,
              message: `فشل الحفظ في Supabase: ${errBody}`
            }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        } else {
          return new Response(JSON.stringify({
            success: false,
            message: "العملية لم تكتمل بنجاح أو غير صالحة."
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
        message: `خطأ داخل السيرفر: ${err.message}`
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }
};
 
