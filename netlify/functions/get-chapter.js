// =============================================================================
// WEBON / get-chapter
// -----------------------------------------------------------------------------
// 役割：
//   有料章の本文JSONを「購入者にだけ」配信する。
//   有料章は静的ファイルとして公開せず（data/chapters/ にはアウトラインのみ）、
//   本文は netlify/functions/chapters-private/ に置いて関数にバンドルする。
//
// リクエスト：
//   GET /.netlify/functions/get-chapter?id=ch1
//   Authorization: Bearer <Supabase access_token>
//
// レスポンス：
//   200 … 章のフルJSON（pages / sections）
//   401 … トークンなし・無効
//   403 … 未購入
//   404 … 不明な章ID
//
// 依存環境変数：
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY
// =============================================================================
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const BOOK_SLUG = "local-thinking";

// 配信を許可する章ID（パストラバーサル防止のためホワイトリスト方式）
const PAID_CHAPTERS = new Set(["ch1", "ch2", "ch3", "ch4", "ch5", "ch6", "epilogue"]);

function readChapterFile(id) {
  // esbuildバンドル後も included_files は関数ディレクトリ相対で展開されるため、
  // 候補パスを順に探す。
  const candidates = [
    path.join(__dirname, "chapters-private", `${id}.json`),
    path.join(process.cwd(), "netlify", "functions", "chapters-private", `${id}.json`),
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, "utf8");
    } catch (e) {
      /* try next */
    }
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const id = (event.queryStringParameters && event.queryStringParameters.id) || "";
  if (!PAID_CHAPTERS.has(id)) {
    return { statusCode: 404, body: JSON.stringify({ error: "unknown chapter" }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: "no token" }) };
  }

  try {
    const sbAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { data: userData, error: userErr } = await sbAdmin.auth.getUser(token);
    if (userErr || !userData || !userData.user) {
      return { statusCode: 401, body: JSON.stringify({ error: "invalid token" }) };
    }

    const { data: book } = await sbAdmin
      .from("books")
      .select("id")
      .eq("slug", BOOK_SLUG)
      .maybeSingle();
    if (!book) {
      return { statusCode: 500, body: JSON.stringify({ error: "book not found" }) };
    }

    const { data: purchase } = await sbAdmin
      .from("purchases")
      .select("id")
      .eq("user_id", userData.user.id)
      .eq("book_id", book.id)
      .maybeSingle();
    if (!purchase) {
      return { statusCode: 403, body: JSON.stringify({ error: "not purchased" }) };
    }

    const json = readChapterFile(id);
    if (!json) {
      // 本文がまだビルドされていない章（執筆中）は空オブジェクトを返す
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: "{}",
      };
    }
    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json",
        // 購入者ごとの認可付きレスポンスなので共有キャッシュには載せない
        "cache-control": "private, max-age=300",
      },
      body: json,
    };
  } catch (e) {
    console.error("get-chapter error", e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message || String(e) }) };
  }
};
