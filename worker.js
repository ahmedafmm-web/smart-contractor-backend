      // ----------------------------------------------------
      // 3. التحقق والتفعيل المباشر مع طباعة التشخيص الكامل
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

        let isSuccess = false;
        let amountCents = 0;
        let logAttempt1 = {}, logAttempt2 = {}, logAttempt3 = {};

        // 1️⃣ فحص Acceptance Transaction API مباشرة
        try {
          const res1 = await fetch(`https://accept.paymob.com/api/acceptance/transactions/${cleanTxId}`, {
            method: "GET",
            headers: {
              "Authorization": `Token ${PAYMOB_SECRET_KEY}`,
              "Content-Type": "application/json"
            }
          });
          const data1 = await res1.json();
          logAttempt1 = { status: res1.status, response: data1 };

          if (res1.ok && (data1.success === true || data1.is_success === true) && data1.pending === false) {
            isSuccess = true;
            amountCents = data1.amount_cents || 0;
          }
        } catch(e) { logAttempt1 = { error: e.message }; }

        // 2️⃣ فحص E-Commerce Order API
        if (!isSuccess) {
          try {
            const res2 = await fetch(`https://accept.paymob.com/api/ecommerce/orders/${cleanTxId}`, {
              method: "GET",
              headers: {
                "Authorization": `Token ${PAYMOB_SECRET_KEY}`,
                "Content-Type": "application/json"
              }
            });
            const data2 = await res2.json();
            logAttempt2 = { status: res2.status, response: data2 };

            if (res2.ok && (data2.paid_at || data2.is_paid === true)) {
              isSuccess = true;
              amountCents = data2.amount_cents || 0;
            }
          } catch(e) { logAttempt2 = { error: e.message }; }
        }

        // 3️⃣ فحص Intention API
        if (!isSuccess) {
          try {
            const res3 = await fetch(`https://accept.paymob.com/v1/intention/${cleanTxId}/`, {
              method: "GET",
              headers: {
                "Authorization": `Token ${PAYMOB_SECRET_KEY}`,
                "Content-Type": "application/json"
              }
            });
            const data3 = await res3.json();
            logAttempt3 = { status: res3.status, response: data3 };

            if (res3.ok && (data3.status === "SUCCESS" || data3.status === "COMPLETED" || data3.is_paid === true)) {
              isSuccess = true;
              amountCents = data3.amount || data3.amount_cents || 0;
            }
          } catch(e) { logAttempt3 = { error: e.message }; }
        }

        // تنفيذ التفعيل في Supabase
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
            message: `تشخيص Paymob على الرقم (${cleanTxId}): [Tx: Status ${logAttempt1.status}] | [Order: Status ${logAttempt2.status}] | [Intention: Status ${logAttempt3.status}] - الرد النهائي: ${JSON.stringify(logAttempt1.response || logAttempt3.response || {})}`
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }
