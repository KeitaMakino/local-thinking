// =============================================================================
// WEBON / stripe-webhook
// -----------------------------------------------------------------------------
// 役割：
//   Stripeから決済イベントを受け取り、checkout.session.completed の場合に
//   Supabaseの purchases テーブルに行を追加する。
//
// 重要：
//   - 署名検証 (constructEvent) を必ず通すこと。
//   - event.body は文字列のまま使う必要があるため、Netlify Functions では
//     event.body をそのまま使用する（パースしてはいけない）。
//
// 依存環境変数：
//   - STRIPE_SECRET_KEY
//   - STRIPE_WEBHOOK_SECRET
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY
// =============================================================================
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = event.headers["stripe-signature"] || event.headers["Stripe-Signature"];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      // Netlify ではbodyがbase64の場合がある
      event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("webhook signature verification failed", err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type !== "checkout.session.completed") {
    // 別イベントタイプは無視（必要に応じて拡張）
    return { statusCode: 200, body: JSON.stringify({ received: true, ignored: stripeEvent.type }) };
  }

  const session = stripeEvent.data.object;
  const userId = session.metadata && session.metadata.user_id;
  const bookId = session.metadata && session.metadata.book_id;
  const amount = session.amount_total; // 単位：最小通貨単位（JPYなら円そのまま）

  if (!userId || !bookId) {
    console.error("missing metadata on session", session.id);
    return { statusCode: 400, body: "missing metadata" };
  }

  // 未入金（コンビニ払い等の遅延決済を将来追加した場合）は購入記録を作らない。
  // その場合は checkout.session.async_payment_succeeded の処理を追加すること。
  if (session.payment_status !== "paid") {
    console.warn("checkout completed but not paid yet", session.id, session.payment_status);
    return { statusCode: 200, body: JSON.stringify({ received: true, deferred: session.payment_status }) };
  }
  if (session.currency && session.currency !== "jpy") {
    console.error("unexpected currency", session.id, session.currency);
    return { statusCode: 400, body: "unexpected currency" };
  }

  const sbAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { error } = await sbAdmin.from("purchases").upsert(
    {
      user_id: userId,
      book_id: bookId,
      stripe_session_id: session.id,
      amount_jpy: amount || 0,
    },
    { onConflict: "user_id,book_id" }
  );

  if (error) {
    console.error("supabase insert error", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true, recorded: true }) };
};
