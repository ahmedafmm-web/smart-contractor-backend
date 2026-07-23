export default {
  async fetch(request, env) {
    // 1. التعامل مع طلبات Preflight (CORS)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // التأكد من أن الطلب POST ويفحص البيانات
      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({ success: false, error: "Method Not Allowed" }),
          { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const body = await request.json();
      const { device_id, action } = body;

      if (!device_id) {
        return new Response(
          JSON.stringify({ success: false, error: "device_id is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // -------------------------------------------------------------
      // Action 1: تفعيل التجربة المجانية (48 ساعة)
      // -------------------------------------------------------------
      if (action === "activate_trial") {
        // حساب تاريخ الانتهاء (48 ساعة من اللحظة الحالية)
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

        // إرسال طلب UPSERT لـ Supabase عبر REST API
        const supabaseResponse = await fetch(
          `${env.SUPABASE_URL}/rest/v1/subscriptions`,
          {
            method: "POST",
            headers: {
              "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "resolution=merge-duplicates,return=representation"
            },
            body: JSON.stringify({
              device_id: device_id,
              status: "trial",
              expires_at: expiresAt,
              updated_at: new Date().toISOString()
            })
          }
        );

        const supabaseData = await supabaseResponse.json();

        // التثبت من استجابة Supabase
        if (!supabaseResponse.ok) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "فشل تسجيل البيانات في Supabase",
              details: supabaseData
            }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({
            success: true,
            message: `✅ تم تفعيل التجربة المجانية بنجاح للجهاز: ${device_id}`,
            data: supabaseData
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // -------------------------------------------------------------
      // Action 2: التحقق من حالة الاشتراك للجهاز
      // -------------------------------------------------------------
      if (action === "check_status") {
        const supabaseResponse = await fetch(
          `${env.SUPABASE_URL}/rest/v1/subscriptions?device_id=eq.${encodeURIComponent(device_id)}&select=*`,
          {
            method: "GET",
            headers: {
              "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json"
            }
          }
        );

        const supabaseData = await supabaseResponse.json();

        if (!supabaseResponse.ok) {
          return new Response(
            JSON.stringify({ success: false, error: "خطأ أثناء جلب حالة الجهاز", details: supabaseData }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        if (supabaseData.length === 0) {
          return new Response(
            JSON.stringify({ success: true, subscribed: false, message: "الجهاز غير مسجل" }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const record = supabaseData[0];
        const isExpired = new Date(record.expires_at) < new Date();

        return new Response(
          JSON.stringify({
            success: true,
            subscribed: !isExpired,
            status: record.status,
            expires_at: record.expires_at,
            is_expired: isExpired
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ success: false, error: "Action غير معروف" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );

    } catch (err) {
      return new Response(
        JSON.stringify({ success: false, error: err.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }
};
