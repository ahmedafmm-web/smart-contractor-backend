export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ success: false, message: "Method Not Allowed" }), {
        status: 405,
        headers: corsHeaders
      });
    }

    try {
      const body = await request.json().catch(() => ({}));
      const transaction_id = body.transaction_id;

      const PAYMOB_SECRET_KEY = "Egy_sk_test_77f935610c2ff1f26dee1bf30935de08839d7f204af02861ca93bdaeb8f95242";
      const SUPABASE_URL = "https://lwffkkzdkvafyuwrcbzl.supabase.co"; 
      const SUPABASE_ANON_KEY = "EyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx3ZmZra3pka3ZhZnl1d3JjYnpsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzODQ5NzUsImV4cCI6MjA5OTk2MDk3NX0.hD7SWLaZ1c1tNfSNuKYHceaqCqS1riqTb1BxfM3_2uA"; 

      if (!transaction_id) {
        return new Response(JSON.stringify({ success: false, message: "رقم المعاملة أو الإيصال مطلوب" }), {
          status: 400,
          headers: corsHeaders
        });
      }

      // 1️⃣ الفحص في Supabase لتكرار الريسيت
      const supaCheck = await fetch(`${SUPABASE_URL}/rest/v1/payments?transaction_id=eq.${transaction_id}&select=transaction_id`, {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      });

      if (supaCheck.ok) {
        const existingData = await supaCheck.json();
        if (Array.isArray(existingData) && existingData.length > 0) {
          return new Response(JSON.stringify({ 
            success: false, 
            already_used: true, 
            message: "هذا الريسيت تم استخدامه وتفعيله من قبل!" 
          }), {
            status: 200,
            headers: corsHeaders
          });
        }
      }

      // 2️⃣ المحاولة الأولى: الفحص المباشر كـ Transaction ID
      let paymobRes = await fetch(`https://accept.paymob.com/api/acceptance/transactions/${transaction_id}`, {
        method: 'GET',
        headers: {
          'Authorization': `Token ${PAYMOB_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      let data = null;

      if (paymobRes.ok) {
        data = await paymobRes.json();
      } else {
        // 3️⃣ المحاولة الثانية: الفحص كـ Order ID / Receipt No إذا فشل الفحص الأول
        const orderRes = await fetch(`https://accept.paymob.com/api/ecommerce/orders/${transaction_id}`, {
          method: 'GET',
          headers: {
            'Authorization': `Token ${PAYMOB_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        if (orderRes.ok) {
          const orderData = await orderRes.json();
          // أخذ أول معاملة ناجحة مرتبطة بهذا الطلب
          if (orderData.tx_ns && orderData.tx_ns.length > 0) {
            data = orderData.tx_ns[0];
          } else {
            // محاكاة استرجاع البيانات بالعمق من الطلب نفسه
            data = {
              success: orderData.is_payment_locked || orderData.paid_amount_cents > 0,
              pending: false,
              amount_cents: orderData.amount_cents || orderData.paid_amount_cents
            };
          }
        }
      }

      if (!data) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: `لم يتم العثور على المعاملة أو الإيصال (${transaction_id}) في Paymob.` 
        }), {
          status: 200,
          headers: corsHeaders
        });
      }

      const isSuccess = (data.success === true) && (data.pending === false);
      const amountInEgp = data.amount_cents ? (data.amount_cents / 100) : 0;

      return new Response(JSON.stringify({ 
        success: isSuccess, 
        amount: amountInEgp,
        already_used: false 
      }), {
        status: 200,
        headers: corsHeaders
      });

    } catch (err) {
      return new Response(JSON.stringify({ success: false, message: err.message || "حدث خطأ غير متوقع" }), {
        status: 500,
        headers: corsHeaders
      });
    }
  }
};
