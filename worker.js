      if (body.action === "activate_trial") {
        const { device_id } = body;

        if (!device_id) {
          return new Response(JSON.stringify({
            success: false,
            message: "يرجى اختيار وإدخال كود الجهاز."
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

        // قراءة الاستجابة الكاملة لمعرفة سبب الرفض بالتفصيل
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
