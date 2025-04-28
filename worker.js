/**
 * LINE 個人ボット (定期リマインド + Gemini 2.0 Flash で自動返信)
 * Cloudflare Workers 1ファイル実装
 */
export default {
    // ──────────────────────────────── 1) Webhook 受信 ──
    async fetch(request, env) {
      if (request.method !== "POST") {
        return new Response("OK");        // GET などは健全性チェック用
      }
  
      // --- 署名検証 ----------------------------------------------------------
      const body = await request.text();
      const signature = request.headers.get("x-line-signature") || "";
      const keyData = new TextEncoder().encode(env.CHANNEL_SECRET);
      const algo = { name: "HMAC", hash: "SHA-256" };
      const cryptoKey = await crypto.subtle.importKey("raw", keyData, algo, false, ["sign"]);
      const mac = await crypto.subtle.sign(algo, cryptoKey, new TextEncoder().encode(body));
      const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
      if (expected !== signature) return new Response("Bad signature", { status: 400 });
      // ----------------------------------------------------------------------
  
      const payload = JSON.parse(body);
      const event = payload?.events?.[0];
      if (event?.type !== "message" || event.message.type !== "text") {
        return new Response("No-op");
      }
  
      const userText = event.message.text;
  
      // --- Gemini 2.0 Flash で応答生成 --------------------------------------
      const geminiRes = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
          + `?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: {                           // ← システムプロンプトを渡す場所
              parts: [{ text: env.SYSTEM_PROMPT || "" }]
            },
            contents: [
              { parts: [{ text: userText }], role: "user" }
            ]
          })
        }
      ).then(r => r.json());
  
      const answer =
        geminiRes.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
        "（エラー: Gemini から応答なし）";
      // ----------------------------------------------------------------------
  
      // --- LINE へ reply -----------------------------------------------------
      await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}`
        },
        body: JSON.stringify({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: answer }]
        })
      });
      // ----------------------------------------------------------------------
  
      return new Response("OK");
    },
  
    // ──────────────────────────────── 2) Cron トリガ ──
    async scheduled(_controller, env) {
      const jstNow = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
      await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}`
        },
        body: JSON.stringify({
          to: env.MY_USER_ID,
          messages: [{ type: "text", text: `⏰ リマインダー\n${jstNow}` }]
        })
      });
    }
  };
  