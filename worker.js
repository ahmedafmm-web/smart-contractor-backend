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

      const body = await request.json();

      const SUPABASE_URL = "https://lwffkkzdkvafyuwrcbzl.supabase.co";
      const SUPABASE_SERVICE_ROLE_KEY = (env.SUPABASE_SERVICE_ROLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx3ZmZra3pka3ZhZnl1d3JjYnpsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDM4NDk3NSwiZXhwIjoyMDk5OTYwOTc1fQ.PLACEHOLDER").replace(/\s+/g, "");

      const PAYMOB_SECRET_KEY = (env.PAYMOB_SECRET_KEY || "").replace(/\s+/g, "");
      const PAYMOB_PUBLIC_KEY = (env.PAYMOB_PUBLIC_KEY || "").replace(/\s+/g, "");

      // ----------------------------------------------------
      // 1. تفعيل التجربة المجانية
      // ----------------------------------------------------
      if (body.action === "activate_trial") {
        const deviceId = body.device_id;
        if (!deviceId) {
          return new Response(JSON.stringify({
            success: false,
            message: "يرجى إدخال كود الجهاز لتفعيل التجربة."
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/users?device_id=eq.${encodeURIComponent(deviceId)}&select=*`, {
          method: "GET",
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json"
          }
        });

        if (checkRes.ok) {
          const existingUsers = await checkRes.json();
          if (existingUsers && existingUsers.length > 0 && existingUsers[0].trial_expires_at) {
            return new Response(JSON.stringify({
              success: false,
              already_used: true,
              message: "⚠️ لقد تم استخدام الفترة التجريبية لهذا الجهاز من قبل!",
              trial_expires_at: existingUsers[0].trial_expires_at
            }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }

        const now = new Date();
        now.setHours(now.getHours() + 48);
        const trialExpiry = now.toISOString();

        const supabaseEndpoint = `${SUPABASE_URL}/rest/v1/users?on_conflict=device_id`;

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
            is_subscribed: false,
            subscription_expires_at: null,
            trial_expires_at: trialExpiry
          }])
        });

        const resText = await supabaseRes.text();
        let parsedData;
        try { parsedData = JSON.parse(resText); } catch (e) { parsedData = resText; }

        if (supabaseRes.ok) {
          return new Response(JSON.stringify({
            success: true,
            message: `✅ تم تفعيل التجربة المجانية بنجاح لمدة 48 ساعة للجهاز: ${deviceId}`,
            trial_expires_at: trialExpiry,
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

        let paymobRes = await fetch("https://accept.paymob.com/v1/intention/", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${PAYMOB_SECRET_KEY}`,
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
      // 3. التحقق والتفعيل اليدوي الأكيد (verify_payment)
      // ----------------------------------------------------
      if (body.action === "verify_payment") {
        const { transaction_id, device_id } = body;

        if (!transaction_id || !device_id) {
          return new Response(JSON.stringify({
            success: false,
            message: "يرجى إدخال رقم العملية وكود الجهاز."
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const cleanTxId = String(transaction_id).replace(/\D/g, '').trim();

        // 🛡️ فحص عدم تكرار الريسيت بداخل Supabase
        try {
          const checkTxRes = await fetch(`${SUPABASE_URL}/rest/v1/users?last_transaction_id=eq.${encodeURIComponent(cleanTxId)}&select=device_id`, {
            method: "GET",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json"
            }
          });

          if (checkTxRes.ok) {
            const usedTxUsers = await checkTxRes.json();
            if (usedTxUsers && usedTxUsers.length > 0 && usedTxUsers[0].device_id !== device_id) {
              return new Response(JSON.stringify({
                success: false,
                message: "⚠️ رقم العملية هذا تم استخدامه بالفعل لتفعيل جهاز آخر!"
              }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
          }
        } catch (e) {}

        // 🔑 Step 1: الحصول على Auth Token رسمي ومضمون من Paymob
        const authRes = await fetch("https://accept.paymob.com/api/auth/tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: PAYMOB_SECRET_KEY })
        });

        const authData = await authRes.json();
        if (!authRes.ok || !authData.token) {
          return new Response(JSON.stringify({
            success: false,
            message: `فشل مصادقة المفتاح مع Paymob: ${JSON.stringify(authData)}`
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const authToken = authData.token;

        // 🔑 Step 2: الاستعلام بـ Auth Token الصحيح
        const verifyRes = await fetch(`https://accept.paymob.com/api/acceptance/transactions/${cleanTxId}`, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${authToken}`,
            "Content-Type": "application/json"
          }
        });

        const txData = await verifyRes.json();
        let isSuccess = false;
        let amountCents = 0;

        if (verifyRes.ok && (txData.success === true || txData.is_success === true) && txData.pending === false) {
          isSuccess = true;
          amountCents = txData.amount_cents || 0;
        }

        // 🔑 Step 3: التفعيل بداخل Supabase
        if (isSuccess) {
          const now = new Date();
          if (amountCents >= 200000) {
            now.setFullYear(now.getFullYear() + 1);
          } else {
            now.setMonth(now.getMonth() + 1);
          }

          const subExpiry = now.toISOString();
          const supabaseEndpoint = `${SUPABASE_URL}/rest/v1/users?on_conflict=device_id`;

          const supabaseRes = await fetch(supabaseEndpoint, {
            method: "POST",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "resolution=merge-duplicates,return=representation"
            },
            body: JSON.stringify([{
              device_id: device_id,
              is_subscribed: true,
              subscription_expires_at: subExpiry,
              trial_expires_at: null,
              last_transaction_id: cleanTxId
            }])
          });

          if (supabaseRes.ok) {
            return new Response(JSON.stringify({
              success: true,
              message: `✅ تم التفعيل بنجاح! ينتهي اشتراكك في: ${now.toLocaleDateString('ar-EG')}`,
              expires_at: subExpiry
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
            message: `عملية غير معتمدة أو رقم إيصال غير صحيح: ${JSON.stringify(txData)}`
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
