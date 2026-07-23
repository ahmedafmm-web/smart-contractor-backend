      // =========================================================
      // 🆕 1. إنشاء جلسة دفع ديناميكية (Dynamic Payment Intent)
      // =========================================================
      if (body.action === "create_payment_intent") {
        const planType = body.plan_type || "monthly";
        const deviceId = body.device_id || "UNKNOWN";
        const amountCents = (planType === "yearly") ? 200000 : 25000;

        try {
          const paymobIntentRes = await fetch("https://accept.paymob.com/api/ecommerce/payment-intents", {
            method: "POST",
            headers: {
              "Authorization": `Token ${PAYMOB_SECRET_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              amount: amountCents,
              currency: "EGP",
              payment_methods: ["card"],
              billing_data: {
                first_name: "Smart",
                last_name: "Contractor",
                email: "client@smartcontractor.com",
                phone_number: "+201000000000"
              },
              special_reference: `SC_${deviceId}_${Date.now()}`
            })
          });

          const intentData = await paymobIntentRes.json();

          if (paymobIntentRes.ok && intentData.client_secret) {
            const clientSecret = intentData.client_secret;
            const paymentUrl = `https://accept.paymob.com/unifiedcheckout/?publicKey=${PAYMOB_PUBLIC_KEY}&clientSecret=${clientSecret}`;
            
            return new Response(JSON.stringify({
              success: true,
              payment_url: paymentUrl,
              intent_id: intentData.id
            }), { status: 200, headers: corsHeaders });
          } else {
            // كشف سبب الرفض الحقيقي من Paymob
            console.error("Paymob Error:", intentData);
            return new Response(JSON.stringify({
              success: false,
              message: intentData.message || JSON.stringify(intentData) || "رفض من سيرفر Paymob"
            }), { status: 200, headers: corsHeaders });
          }
        } catch (err) {
          return new Response(JSON.stringify({
            success: false,
            message: `خطأ اتصال: ${err.message}`
          }), { status: 200, headers: corsHeaders });
        }
      }
 
