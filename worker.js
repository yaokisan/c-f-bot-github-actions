/**
 * LINE 個人ボット (定期リマインド + Gemini 2.0 Flash で自動返信)
 * Cloudflare Workers 1ファイル実装
 */
// === System Prompt ======================================================
const SYSTEM_PROMPT = `
# 指示
以下のステップに従ってユーザーに返信してください。

## Step1
ユーザーは以下のフォーマットに従い、CとFそれぞれの数値をインプットします。
ーーー
現在の明瞭度と疲労度を入力してください。
C（Clarity - 明瞭度）：%
F（Fatigue - 疲労度）：%
ーーー

## Step2
入力された数値に応じて、以下の①〜⑨のルールで返信してください。出力は以下に記載された返信パターンそのままで出力し、追加の文章などは不要です。

### C≧70% かつ F≦50% の場合
最高の調子です！どんどん実行していきましょう！

### C≧70% かつ 70%≧F>50% の場合
ピントは明瞭ですが、やや疲労が溜まっています。

15分前後の仮眠/散歩/ストレッチなどリフレッシュを入れましょう。

### 70%>C≧50% かつ F≦50% の場合
身体は元気ですが、ややピントがボケています。簡易アファメーションを入れましょう。

### 70%>C≧50% かつ 70%≧F>50% の場合
ピントがややボケていて、疲労も溜まっています。

15分前後の仮眠/散歩/ストレッチなどリフレッシュを入れ、その後簡易アファメーションを入れましょう。

### C<50% かつ 70%≧F>50% の場合
ピントがかなりボケており、目的や目標から丁寧に見直しが必要です。

また、やや疲労が溜まっています。

15分前後の仮眠/散歩/ストレッチなどリフレッシュを入れ、その後速やかに最低1h以上のセット時間を設けましょう。

### C<50% かつ F>70% の場合
【アラート】
ピントがかなりボケており、目的や目標から丁寧に見直しが必要です。また、かなり疲労が溜まっています。
今日は衝動に注意してなるべく早急に睡眠を取り、必要であればストレッチ等を実施してください。寝る前の過食なども控えてください。
そして最低1h以上のセット時間を速やかに設け、軌道修正を最優先にしてください。

### C≧70 かつ F>70 の場合
ピントは明瞭ですが、かなり疲れが溜まっています。

しっかりと睡眠を取り、必要であればストレッチ等を実施してください。

### 50<C<70 かつ F>70 の場合
ピントがややボケており、かなりの疲れが溜まっています。

しっかりと睡眠を取り、必要であればストレッチ等を実施してください。

その後、簡易アファメーションを入れましょう。

### C<50 かつ F≦50 の場合
身体は元気ですが、ピントがかなりボケており目的や目標から丁寧に見直しが必要です。

速やかに1h以上のセット時間を設けましょう。
`;
// =======================================================================
export default {
    // ──────────────────────────────── 1) Webhook 受信 ──
    async fetch(request, env) {
      if (request.method !== "POST") {
        return new Response("OK");        // GET などは健全性チェック用
      }

      // === 手動 /cron テスト用エンドポイント ===
      const url = new URL(request.url);
      if (url.pathname === "/cron") {
        const jstNow = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
        await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}`
          },
          body: JSON.stringify({
            to: env.MY_USER_ID,
            messages: [{
              type: "text",
              text: "現在の明瞭度と疲労度を入力してください。\nC（Clarity - 明瞭度）：%\nF（Fatigue - 疲労度）：%"
            }]
          })
        });
        return new Response("cron ok");   // ここで早期終了（署名検証をスキップ）
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
            systemInstruction: {
              parts: [{ text: SYSTEM_PROMPT }]
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
          messages: [{
            type: "text",
            text: "現在の明瞭度と疲労度を入力してください。\nC（Clarity - 明瞭度）：%\nF（Fatigue - 疲労度）：%"
          }]
        })
      });
    }
  };