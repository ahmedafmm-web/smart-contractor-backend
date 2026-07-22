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
      return new Response(JSON.stringify({ 
        success: false, 
        message: "طريقة الطلب غير مسموح بها (Method Not Allowed)" 
      }), {
        status: 405,
        headers: corsHeaders
      });
    }

    try {
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

      // 1️⃣ الفحص في Supabase لمنع إعادة الاستخدام
      try {
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
      } catch (supaErr) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: `خطأ أثناء الاتصال بقاعدة البيانات: ${supaErr.message}` 
        }), {
          status: 500,
          headers: corsHeaders
        });
      }

      // 2️⃣ الاستعلام المزدوج من Paymob
      let isSuccess = false;
      let amountInEgp = 0;

      // التجربة الأولى: عبر Unified Intention API (للمفاتيح الحديثة Egy_sk_)
      try {
        const intentionRes = await fetch(`https://accept.paymob.com/v1/intention/${transaction_id}`, {
          method: 'GET',
          headers: {
            'Authorization': `Token ${PAYMOB_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        if (intentionRes.ok) {
          const intData = await intentionRes.json();
          if (intData.status === "PAID" || intData.is_paid === true || intData.status === "SUCCESS") {
            isSuccess = true;
            const amountCents = intData.amount || intData.intention_detail?.amount || 0;
            amountInEgp = amountCents / 100;
          }
        }
      } catch (e) {
        // التجربة الأولى لم تكتمل، ننتقل للثانية
      }

      // التجربة الثانية: إذا لم تنجح الأولى، يجرب Acceptance API التقليدي
      if (!isSuccess) {
        try {
          const acceptanceRes = await fetch(`https://accept.paymob.com/api/acceptance/transactions/${transaction_id}`, {
            method: 'GET',
            headers: {
              'Authorization': `Token ${PAYMOB_SECRET_KEY}`,
              'Content-Type': 'application/json'
            }
          });

          if (acceptanceRes.ok) {
            const accData = await acceptanceRes.json();
            if (accData.success === true && accData.pending === false) {
              isSuccess = true;
              amountInEgp = accData.amount_cents ? (accData.amount_cents / 100) : 0;
            }
          }
        } catch (e) {
          // خطأ في الاتصال بالأكسبتنس
        }
      }

      // 3️⃣ التحقق من النتيجة النهائية للطلب
      if (!isSuccess) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: "لم يتم العثور على الفاتورة في بايموب أو المعاملة مرفوضة/غير مكتملة." 
        }), {
          status: 200,
          headers: corsHeaders
        });
      }

      if (amountInEgp <= 0) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: "تعذر استخراج مبلغ الفاتورة الصحيح من بايموب." 
        }), {
          status: 200,
          headers: corsHeaders
        });
      }

      // 4️⃣ الحفظ الفوري المباشر في Supabase مع تحديد الباقة تلقائيًا
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

      // 5️⃣ إرجاع استجابة النجاح الحقيقية
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
