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
        return new Response(JSON.stringify({ 
          success: false, 
          error_code: "METHOD_NOT_ALLOWED",
          message: "طريقة الطلب غير مسموح بها. يجب استخدام POST." 
        }), {
          status: 405,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // قراءة وفحص الـ Body بداخل Try/Catch منفصل لمعالجة أخطاء JSON المصاغ بشكل خاطئ
      let body;
      try {
        body = await request.json();
      } catch (jsonErr) {
        return new Response(JSON.stringify({
          success: false,
          error_code: "INVALID_JSON_BODY",
          message: "فشل في قراءة بيانات الطلب (Invalid JSON format)",
          details: jsonErr.message
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // جلب وتنظيف المتغيرات البيئية
      const PAYMOB_SECRET_KEY = (env.PAYMOB_SECRET_KEY || "").replace(/\s+/g, "");
      const PAYMOB_PUBLIC_KEY = (env.PAYMOB_PUBLIC_KEY || "").replace(/\s+/g, "");
      const SUPABASE_URL = (env.SUPABASE_URL || "").replace(/\s+/g, "").replace(/\/$/, "");
      const SUPABASE_SERVICE_ROLE_KEY = (env.SUPABASE_SERVICE_ROLE_KEY || "").replace(/\s+/g, "");

      // ----------------------------------------------------
      // 1. تفعيل التجربة المجانية (activate_trial) - 48 ساعة
      // ----------------------------------------------------
      if (body.action === "activate_trial") {
        const deviceId = body.device_id;
        if (!deviceId) {
          return new Response(JSON.stringify({
            success: false,
            error_code: "MISSING_DEVICE_ID",
            message: "يرجى إدخال كود الجهاز (device_id) لتكتمل عملية التفعيل."
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // تشخيص المتغيرات البيئية لـ Supabase
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
          return new Response(JSON.stringify({
            success: false,
            error_code: "ENV_VARIABLES_MISSING",
            message: "خطأ في إعدادات الخادم: متغيرات Supabase غير متوفرة أو فارغة.",
            diagnostics: {
              SUPABASE_URL_EXISTS: Boolean(SUPABASE_URL),
              SUPABASE_SERVICE_ROLE_KEY_EXISTS: Boolean(SUPABASE_SERVICE_ROLE_KEY)
            }
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const expiryDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        const targetEndpoint = `${SUPABASE_URL}/rest/v1/subscriptions`;

        try {
          const supabaseRes = await fetch(targetEndpoint, {
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

          const rawResponseText = await supabaseRes.text();
          let parsedData;
          try { parsedData = JSON.parse(rawResponseText); } catch(e) { parsedData = rawResponseText; }

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
              error_code: "SUPABASE_API_ERROR",
              message: `فشل الكتابة في Supabase (كود الاستجابة: ${supabaseRes.status})`,
              status_code: supabaseRes.status,
              target_url: targetEndpoint,
              response_payload: parsedData
            }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        } catch (fetchErr) {
          return new Response(JSON.stringify({
            success: false,
            error_code: "SUPABASE_FETCH_EXCEPTION",
            message: "تعذر الاتصال بـ Supabase بسبب خطأ شبكة أو DNS.",
            error_details: fetchErr.message,
            target_url: targetEndpoint
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      // ----------------------------------------------------
      // 2. إنشاء جلسة الدفع (create_payment_intent) - Paymob
      // ----------------------------------------------------
      if (body.action === "create_payment_intent") {
        if (!PAYMOB_SECRET_KEY || !PAYMOB_PUBLIC_KEY) {
          return new Response(JSON.stringify({
            success: false,
            error_code: "PAYMOB_CONFIG_MISSING",
            message: "خطأ في التكوين: مفاتيح Paymob غير معرفة بداخل Cloudflare Variables.",
            diagnostics: {
              PAYMOB_SECRET_KEY_EXISTS: Boolean(PAYMOB_SECRET_KEY),
              PAYMOB_PUBLIC_KEY_EXISTS: Boolean(PAYMOB_PUBLIC_KEY)
            }
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const planType = body.plan_type || "monthly";
        const deviceId = body.device_id || "UNKNOWN";
        const amountCents = (planType === "yearly") ? 200000 : 25000;

        const CARD_INTEGRATION_ID = 5790552;
        const WALLET_INTEGRATION_ID = 5783298;

        let authHeader = `Secret ${PAYMOB_SECRET_KEY}`;
        if (PAYMOB_SECRET_KEY.startsWith("Egy_sk_")) {
          authHeader = `Bearer ${PAYMOB_SECRET_KEY}`;
        }

        try {
          let paymobIntentRes = await fetch("https://accept.paymob.com/v1/intention/", {
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

          // خيار احتياطي بنظام Token إذا تم رفض التوثيق الرئيسي
          if (paymobIntentRes.status === 401 || paymobIntentRes.status === 403) {
            paymobIntentRes = await fetch("https://accept.paymob.com/v1/intention/", {
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

          const rawPaymobText = await paymobIntentRes.text();
          let intentData;
          try { intentData = JSON.parse(rawPaymobText); } catch(e) { intentData = rawPaymobText; }

          if (paymobIntentRes.ok && typeof intentData === "object") {
            const clientSecret = intentData.client_secret || intentData.cs;
            if (clientSecret) {
              const paymentUrl = `https://accept.paymob.com/unifiedcheckout/?publicKey=${PAYMOB_PUBLIC_KEY}&clientSecret=${clientSecret}`;
              return new Response(JSON.stringify({
                success: true,
                payment_url: paymentUrl
              }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
          }

          return new Response(JSON.stringify({
            success: false,
            error_code: "PAYMOB_INTENT_FAILED",
            message: `رفض سيرفر Paymob إنشاء جلسة الدفع (كود الاستجابة: ${paymobIntentRes.status})`,
            status_code: paymobIntentRes.status,
            paymob_response: intentData
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

        } catch (paymobErr) {
          return new Response(JSON.stringify({
            success: false,
            error_code: "PAYMOB_FETCH_EXCEPTION",
            message: "تعذر الاتصال بسيرفر Paymob.",
            error_details: paymobErr.message
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
            error_code: "MISSING_VERIFY_PARAMS",
            message: "يرجى إدخال رقم العملية (transaction_id) وكود الجهاز (device_id)."
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
          console.error("Auth token fetch failed", e.message);
        }

        try {
          const verifyRes = await fetch(`https://accept.paymob.com/api/acceptance/transactions/${transaction_id}`, {
            method: "GET",
            headers: {
              "Authorization": authToken ? `Bearer ${authToken}` : `Token ${PAYMOB_SECRET_KEY}`,
              "Content-Type": "application/json"
            }
          });

          const rawTxText = await verifyRes.text();
          let txData;
          try { txData = JSON.parse(rawTxText); } catch(e) { txData = rawTxText; }

          if (!verifyRes.ok || typeof txData !== "object") {
            return new Response(JSON.stringify({
              success: false,
              error_code: "VERIFY_TRANSACTION_FAILED",
              message: `تعذر جلب تفاصيل العملية من Paymob (كود الاستجابة: ${verifyRes.status})`,
              status_code: verifyRes.status,
              paymob_response: txData
            }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }

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
              body: JSON.stringify([{
                device_id: device_id,
                status: "active",
                expires_at: expiryDate.toISOString(),
                last_transaction_id: String(transaction_id),
                updated_at: new Date().toISOString()
              }])
            });

            const rawSupaText = await supabaseRes.text();
            let supaData;
            try { supaData = JSON.parse(rawSupaText); } catch(e) { supaData = rawSupaText; }

            if (supabaseRes.ok) {
              return new Response(JSON.stringify({
                success: true,
                message: `تم التفعيل بنجاح! ينتهي اشتراكك في: ${expiryDate.toLocaleDateString('ar-EG')}`,
                data: supaData
              }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            } else {
              return new Response(JSON.stringify({
                success: false,
                error_code: "SUPABASE_UPDATE_FAILED",
                message: "تم التحقق من الدفع، ولكن حدث خطأ أثناء التحديث في قاعدة البيانات.",
                status_code: supabaseRes.status,
                supabase_response: supaData
              }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
          } else {
            return new Response(JSON.stringify({
              success: false,
              error_code: "TRANSACTION_NOT_SUCCESSFUL",
              message: "العملية لم تكتمل بنجاح أو ما زالت قيد الانتظار.",
              transaction_status: {
                success: txData.success,
                pending: txData.pending
              }
            }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        } catch (verifyErr) {
          return new Response(JSON.stringify({
            success: false,
            error_code: "VERIFY_FETCH_EXCEPTION",
            message: "حدث خطأ أثناء إجراء عملية التحقق من الاستجابة.",
            error_details: verifyErr.message
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      // Action غير معرووف
      return new Response(JSON.stringify({ 
        success: false, 
        error_code: "UNKNOWN_ACTION",
        message: `الحدث المطلوب (${body.action}) غير معرّف بداخل السيرفر.` 
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (globalErr) {
      // Catch شامل لأي خطأ غير متوقع بداخل الـ Worker
      return new Response(JSON.stringify({
        success: false,
        error_code: "WORKER_CRITICAL_EXCEPTION",
        message: "حدث خطأ حرج غير متوقع بداخل الـ Worker.",
        error_details: globalErr.message,
        stack_trace: globalErr.stack || null
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }
};
