// Cloudflare Worker — Firebase Cloud Function-এর জায়গায়।
// এই Worker কোনো Admin SDK ব্যবহার করে না (Workers runtime-এ Node.js
// dependency চলে না), তাই auth verify আর provisioning check দুটোই
// user-এর নিজের ID token দিয়ে সরাসরি REST API call করে করা হচ্ছে।

const GEMINI_MODEL = "gemini-2.5-flash-lite";

// Gemini-র responseSchema সাধারণ JSON Schema না — নিজস্ব Type enum,
// যেখানে type-এর value uppercase লাগে (OBJECT/STRING/NUMBER)।
// lowercase দিলে schema-টাই invalid গণ্য হয়ে 400 Bad Request আসে।
const TRANSACTION_SCHEMA = {
  type: "OBJECT",
  properties: {
    amount: { type: "NUMBER" },
    type: { type: "STRING", enum: ["income", "expense"] },
    category: { type: "STRING" },
    date: { type: "STRING" },
    note: { type: "STRING" }
  },
  required: ["amount", "type", "category", "date"]
};

function buildPrompt(text, todayBD) {
  return `তুমি একটা বাংলা/ইংরেজি mixed financial transaction parser।
নিচের sentence থেকে transaction-এর তথ্য বের করে JSON আকারে দাও।

আজকের তারিখ (Bangladesh time): ${todayBD}
sentence-এ আলাদা তারিখ উল্লেখ না থাকলে এই তারিখটাই ব্যবহার করো।

Sentence: "${text}"

নিয়ম:
- amount অবশ্যই একটা positive number হবে, কোনো currency symbol ছাড়া।
- type হবে "income" (টাকা এসেছে/পাওয়া গেছে) অথবা "expense" (টাকা খরচ/দেওয়া হয়েছে)।
- category সংক্ষেপে বাংলায় লিখো, sentence অনুযায়ী মানানসই কিছু (যেমন: খাবার, যাতায়াত, বাজার, বাড়িভাড়া, বেতন, বিবিধ)।
- date হবে YYYY-MM-DD ফরম্যাটে।
- note-এ মূল sentence-টার সংক্ষিপ্ত সারমর্ম রাখো।`;
}

// CORS শুধু browser-কে response পড়তে দেয় বা না দেয় — এটা "security" না,
// এটা শুধু defense-in-depth। আসল protection নিচের auth + provisioning check।
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function jsonResponse(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin)
    }
  });
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, origin);
    }

    // ধাপ ১ — Authorization header থেকে Firebase ID token বের করা।
    const authHeader = request.headers.get("Authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return jsonResponse({ error: "আগে login করতে হবে।" }, 401, origin);
    }

    // ধাপ ২ — token আসলেই valid কিনা, Google-এর Identity Toolkit REST API
    // দিয়ে verify করা। এটা accounts:lookup endpoint — expired/জাল token
    // হলে এখানেই error ফেরত আসে, কোনো manual crypto verification লাগে না।
    let uid;
    try {
      const lookupRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_WEB_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken })
        }
      );
      if (!lookupRes.ok) {
        return jsonResponse({ error: "Login session আর valid নেই, আবার login করো।" }, 401, origin);
      }
      const lookupData = await lookupRes.json();
      uid = lookupData && lookupData.users && lookupData.users[0] && lookupData.users[0].localId;
      if (!uid) {
        return jsonResponse({ error: "User যাচাই করা যায়নি।" }, 401, origin);
      }
    } catch (err) {
      return jsonResponse({ error: "Login যাচাই করতে সমস্যা হয়েছে।" }, 401, origin);
    }

    // ধাপ ৩ — input যাচাই।
    let text;
    try {
      const body = await request.json();
      text = body && body.text;
    } catch (err) {
      return jsonResponse({ error: "Invalid request." }, 400, origin);
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      return jsonResponse({ error: "কোনো লেখা পাঠানো হয়নি।" }, 400, origin);
    }
    if (text.length > 300) {
      return jsonResponse({ error: "লেখাটা অনেক বড়, ছোট করে লেখো।" }, 400, origin);
    }

    // ধাপ ৪ — provisioning gate। এখানে user-এর নিজের idToken-টাই RTDB REST
    // call-এর ?auth= param হিসেবে পাঠানো হচ্ছে, তাই এই request database
    // rules দিয়েই evaluate হবে (Admin SDK না, তাই rules bypass হয় না)।
    // /users/{uid} rule-টা এখন এমনভাবে লেখা যে self-read সবসময় allowed —
    // provisioned না থাকলেও নিজের record read করে "নেই" এটা জানা যায়।
    try {
      const provRes = await fetch(
        `${env.FIREBASE_DB_URL}/users/${uid}.json?auth=${idToken}`
      );
      if (!provRes.ok) {
        return jsonResponse({ error: "Access check করতে সমস্যা হয়েছে।" }, 500, origin);
      }
      const userRecord = await provRes.json();
      if (!userRecord) {
        return jsonResponse({ error: "তোমার access এখনো admin approve করেননি।" }, 403, origin);
      }
    } catch (err) {
      return jsonResponse({ error: "Access check করতে সমস্যা হয়েছে।" }, 500, origin);
    }

    // ধাপ ৫ — Gemini call। GEMINI_API_KEY এখানে wrangler secret,
    // কখনো repo-তে commit হয় না।
    const todayBD = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;

    let geminiRes;
    try {
      geminiRes = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(text, todayBD) }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: TRANSACTION_SCHEMA,
            temperature: 0.1,
            maxOutputTokens: 200
          }
        })
      });
    } catch (err) {
      return jsonResponse({ error: "AI service-এর সাথে যোগাযোগ করা যাচ্ছে না।" }, 502, origin);
    }

    if (!geminiRes.ok) {
      // status code-এর পাশাপাশি Gemini-র নিজের error message-ও দেখাই —
      // future-এ সমস্যা হলে guess না করে সরাসরি exact কারণ জানা যাবে।
      let detail = "";
      try {
        const errBody = await geminiRes.json();
        detail = errBody && errBody.error && errBody.error.message ? errBody.error.message : JSON.stringify(errBody);
      } catch (e) {
        detail = await geminiRes.text().catch(() => "(no detail)");
      }
      return jsonResponse({ error: `AI service error (${geminiRes.status}): ${detail}` }, 502, origin);
    }

    const result = await geminiRes.json();
    const rawText =
      result &&
      result.candidates &&
      result.candidates[0] &&
      result.candidates[0].content &&
      result.candidates[0].content.parts &&
      result.candidates[0].content.parts[0] &&
      result.candidates[0].content.parts[0].text;

    if (!rawText) {
      return jsonResponse({ error: "AI থেকে কোনো response পাওয়া যায়নি।" }, 502, origin);
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      return jsonResponse({ error: "AI-এর response বোঝা যায়নি।" }, 502, origin);
    }

    // responseSchema থাকলেও নিজে আরেকবার যাচাই — টাকার ব্যাপার,
    // AI-এর output অন্ধভাবে বিশ্বাস করা হয় না।
    const validType = parsed.type === "income" || parsed.type === "expense";
    const validAmount = typeof parsed.amount === "number" && parsed.amount > 0;
    const validCategory = typeof parsed.category === "string" && parsed.category.trim().length > 0;
    const validDate = typeof parsed.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date);

    if (!validType || !validAmount || !validCategory || !validDate) {
      return jsonResponse({ error: "AI ভুল ফরম্যাটে data দিয়েছে, আবার চেষ্টা করো।" }, 502, origin);
    }

    return jsonResponse(
      {
        amount: parsed.amount,
        type: parsed.type,
        category: parsed.category.trim(),
        date: parsed.date,
        note: typeof parsed.note === "string" ? parsed.note.trim() : ""
      },
      200,
      origin
    );
  }
};
        
