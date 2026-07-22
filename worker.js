export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json"
    };

    // 1️⃣ معالجة طلبات الـ Preflight (CORS)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ 
        success: false, 
        message: "طريقة الطلب غير مسموح بها (Method Not Allowed)" 
      }), {
        status: 405,
        headers: corsHeaders
      });
    }

    try {
      // 2️⃣ قراءة وتحليل بيانات الطلب (Request Body) مع كشف أخطاء الـ JSON
      let body;
      try {
        body = await request.json();
      } catch (jsonErr) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: "خطأ في تنسيق البيانات المرسلة (Invalid JSON Format)" 
        }), {
          status: 400,
          headers: corsHeaders
        });
      }

      const transaction_id = String(body.transaction_id || "").trim();

      const PAYMOB_SECRET_KEY = "Egy_sk_test_77f935610c2ff1f26dee1bf30935de08839d7f204af02861ca93bdaeb8f95242";
      const SUPABASE_URL = "https://lwffkkzdkvafyuwrcbzl.supabase.co"; 
      const SUPABASE_ANON_KEY = "EyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx3ZmZra3pka3ZhZnl1wrcbzlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzODQ5NzUsImV4cCI6MjA5OTk2MDk3NX0.hD7SWLaZ1c1tNfSNuKYHceaqCqS1riqTb1BxfM3_2uA"; 

      if (!transaction_id) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: "برجاء إدخال رقم المعاملة أو الإيصال." 
        }), {
          status: 400,
          headers: corsHeaders
        });
      }

      // 3️⃣ الفحص في Supabase مع معالجة خطأ الاتصال بقاعدة البيانات
      let existingData;
      try {
        const supaCheck = await fetch(`${SUPABASE_URL}/rest/v1/payments?transaction_id=eq.${transaction_id}&select=transaction_id`, {
          method: 'GET',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
          }
        });

        if (supaCheck.ok) {
          existingData = await supaCheck.json();
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
      } catch (supaErr) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: `خطأ أثناء الاتصال بقاعدة البيانات (Supabase Error): ${supaErr.message}` 
        }), {
          status: 500,
          headers: corsHeaders
        });
      }

      // 4️⃣ الاستعلام المباشر من Paymob مع معالجة خطأ الشبكة والـ API
      let paymobRes;
      try {
        paymobRes = await fetch(`https://accept.paymob.com/api/acceptance/transactions/${transaction_id}`, {
          method: 'GET',
          headers: {
            'Authorization': `Token ${PAYMOB_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        });
      } catch (paymobFetchErr) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: `تعذر الاتصال ببوابة بايموب (Paymob Connection Failed): ${paymobFetchErr.message}` 
        }), {
          status: 500,
          headers: corsHeaders
        });
      }

      if (!paymobRes.ok) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: "لم يتم العثور على الفاتورة في نظام بايموب. تأكد من صحة الرقم المدخل." 
        }), {
          status: 200,
          headers: corsHeaders
        });
      }

      let data;
      try {
        data = await paymobRes.json();
      } catch (dataErr) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: "حدث خطأ أثناء قراءة بيانات الفاتورة من بايموب." 
        }), {
          status: 500,
          headers: corsHeaders
        });
      }

      // 5️⃣ التحقق من حالة الدفع الحقيقية
      const isSuccess = (data.success === true) && (data.pending === false);

      if (!isSuccess) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: "عملية الدفع هذه مرفوضة (Declined) أو لم تكتمل بنجاح في بايموب." 
        }), {
          status: 200,
          headers: corsHeaders
        });
      }

      // 6️⃣ استخراج المبلغ الفعلي بالجنيه
      const amountInEgp = data.amount_cents ? (data.amount_cents / 100) : 0;

      if (amountInEgp <= 0) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: "تعذر قراءة قيمة الفاتورة الصحيحة من بايموب." 
        }), {
          status: 200,
          headers: corsHeaders
        });
      }

      // 7️⃣ الحفظ في Supabase مع معالجة أخطاء الإدخال
      const startDate = new Date();
      const isAnnual = amountInEgp >= 2000;
      const durationDays = isAnnual ? 365 : 30;
      const endDate = new Date(startDate.getTime() + (durationDays * 24 * 60 * 60 * 1000));

      const insertPayload = {
        transaction_id: transaction_id,
        amount: amountInEgp,
        plan_type: isAnnual ? "annual" : "monthly",
        activated_at: startDate.toISOString(),
        expires_at: endDate.toISOString(),
        created_at: startDate.toISOString()
      };

      try {
        const supaInsert = await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(insertPayload)
        });

        if (!supaInsert.ok) {
          const insertErrText = await supaInsert.text();
          return new Response(JSON.stringify({ 
            success: false, 
            message: `فشل حفظ عملية التفعيل في قاعدة البيانات: ${insertErrText}` 
          }), {
            status: 500,
            headers: corsHeaders
          });
        }
      } catch (insertErr) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: `خطأ أثناء تسجيل الاشتراك في قاعدة البيانات: ${insertErr.message}` 
        }), {
          status: 500,
          headers: corsHeaders
        });
      }

      // 8️⃣ إرجاع استجابة النجاح النهائية
      return new Response(JSON.stringify({ 
        success: true, 
        amount: amountInEgp,
        plan_type: insertPayload.plan_type,
        activated_at: insertPayload.activated_at,
        expires_at: insertPayload.expires_at,
        already_used: false 
      }), {
        status: 200,
        headers: corsHeaders
      });

    } catch (globalErr) {
      // 9️⃣ الحاوية الشاملة لأي خطأ غير متوقع على مستوى السيرفر بالكامل
      return new Response(JSON.stringify({ 
        success: false, 
        message: `حدث خطأ غير متوقع في الخادم: ${globalErr.message || globalErr}` 
      }), {
        status: 500,
        headers: corsHeaders
      });
    }
  }
};
