export default {
  async fetch(request, env) {
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
        return new Response(JSON.stringify({ success: false, error: "Method Not Allowed" }), {
          status: 405,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const body = await request.json();
      const { device_id, action } = body;

      if (!device_id) {
        return new Response(JSON.stringify({ success: false, error: "device_id مطلوب" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (action === "activate_trial") {
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

        // طلب إدراج/تحديث مباشر في Supabase
        const supabaseResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions`, {
          method: "POST",
          headers: {
            "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=representation"
          },
          body: JSON.stringify([{
            device_id: device_id,
            status: "trial",
            expires_at: expiresAt,
            updated_at: new Date().toISOString()
          }])
        });

        const resText = await supabaseResponse.text();
        let supabaseData;
        try { supabaseData = JSON.parse(resText); } catch(e) { supabaseData = resText; }

        if (!supabaseResponse.ok) {
          return new Response(JSON.stringify({
            success: false,
            message: "فشل الكتابة في Supabase",
            details: supabaseData
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        return new Response(JSON.stringify({
          success: true,
          message: `✅ تم تفعيل التجربة المجانية بنجاح للجهاز: ${device_id}`,
          trial_expires_at: expiresAt,
          data: supabaseData
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ success: false, error: "Action غير معروف" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
