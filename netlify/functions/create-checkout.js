// =============================================================================
// WEBON / create-checkout
// -----------------------------------------------------------------------------
// 役割：
//   フロントから book_slug と Supabase access_token を受け取り、
//   Stripe Checkout Session を作成して、その URL を返す。
//
// 認証：
//   フロントは Supabase の access_token (JWT) を Authorization ヘッダで送る。
//   このトークンを Supabase 側で検証してユーザー特定する。
//
// 依存環境変数：
//   - STRIPE_SECRET_KEY
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY
// =============================================================================
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { book_slug } = JSON.parse(event.body || "{}");
    if (!book_slug) {
      return { statusCode: 400, body: JSON.stringify({ error: "book_slug required" }) };
    }

    // Authorization: Bearer <jwt>
    const authHeader = event.headers.authorization || event.headers.Authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return { statusCode: 401, body: JSON.stringify({ error: "no token" }) };
    }

    // Service-role Supabaseクライアントでトークンを検証＋book情報取得
    const sbAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { data: userData, error: userErr } = await sbAdmin.auth.getUser(token);
    if (userErr || !userData || !userData.user) {
      return { statusCode: 401, body: JSON.stringify({ error: "invalid token" }) };
    }
    const user = userData.user;

    const { data: book, error: bookErr } = await sbAdmin
      .from("books")
      .select("id, slug, title, stripe_price_id, price_jpy")
      .eq("slug", book_slug)
      .maybeSingle();
    if (bookErr || !book) {
      return { statusCode: 404, body: JSON.stringify({ error: "book not found" }) };
    }
    if (!book.stripe_price_id) {
      return { statusCode: 500, body: JSON.stringify({ error: "stripe_price_id not set on book" }) };
    }

    // 既購入チェック
    const { data: already } = await sbAdmin
      .from("purchases")
      .select("id")
      .eq("user_id", user.id)
      .eq("book_id", book.id)
      .maybeSingle();
    if (already && already.id) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: "already purchased" })
      };
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const origin = event.headers.origin || `https://${event.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price: book.stripe_price_id, quantity: 1 }],
      customer_email: user.email,
      client_reference_id: user.id,
      metadata: {
        user_id: user.id,
        book_id: book.id,
        book_slug: book.slug,
      },
      success_url: `${origin}/?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/?purchase=cancel`,
    });

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: session.url, id: session.id }),
    };
  } catch (e) {
    console.error("create-checkout error", e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message || String(e) }) };
  }
};
