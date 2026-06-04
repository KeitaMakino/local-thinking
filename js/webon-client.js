/* ============================================================================
   WEBON client (stub)
   ----------------------------------------------------------------------------
   Supabaseアカウント作成後、SUPABASE_URL と SUPABASE_ANON_KEY を埋めれば
   このクライアントが auth/notes/purchases を取り扱う窓口になる。

   この段階ではキーが空なので、関数は no-op で動作する（フロントは壊れない）。
   ============================================================================ */
(function(){
  "use strict";

  /* === WEBON Supabase接続 ============================================
     anonキーは公開して問題ない（Row Level Securityで制御される）。
     service_role キーは絶対にここに書かないこと。 */
  var SUPABASE_URL      = "https://ezcafdlgpxpwgjatbcgo.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6Y2FmZGxncHhwd2dqYXRiY2dvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1NTgxMTQsImV4cCI6MjA5NjEzNDExNH0.Hd3bJa-_wjujQrujEgci6dD0ijUjGc3Vc5-wxOFoUhk";
  /* ================================================================= */

  /* この書籍のslug。multi-book化したらここを書き換える、または外から渡す。 */
  var BOOK_SLUG = "local-thinking";

  /* Supabase JS は CDNから後で読み込む（キーが空なら何もしない） */
  var sb = null;
  var ready = false;

  function init(){
    if(!SUPABASE_URL || !SUPABASE_ANON_KEY){
      console.info("[WEBON] keys not set yet — running in offline mode");
      return;
    }
    if(!window.supabase){
      console.warn("[WEBON] supabase-js not loaded");
      return;
    }
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    ready = true;
    console.info("[WEBON] connected, book =", BOOK_SLUG);
    /* 接続確認：booksテーブルからこの書籍を読めるか */
    sb.from('books').select('id,slug,title').eq('slug', BOOK_SLUG).maybeSingle()
      .then(function(r){
        if(r.error){
          console.error("[WEBON] books select error:", r.error.message);
        } else if(!r.data){
          console.warn("[WEBON] book not found in DB. Did you run webon_schema.sql?");
        } else {
          console.info("[WEBON] book loaded:", r.data);
        }
      });
  }

  /* ===== 公開API ================================================= */
  window.WEBON = {
    bookSlug: BOOK_SLUG,
    isReady: function(){ return ready; },

    /* 認証 */
    signInWithMagicLink: async function(email){
      if(!ready) return {error: {message: "offline"}};
      return await sb.auth.signInWithOtp({
        email: email,
        options: { emailRedirectTo: window.location.origin + window.location.pathname }
      });
    },
    signOut: async function(){
      if(!ready) return;
      await sb.auth.signOut();
    },
    getUser: async function(){
      if(!ready) return null;
      var r = await sb.auth.getUser();
      return r.data ? r.data.user : null;
    },
    getAccessToken: async function(){
      if(!ready) return null;
      var r = await sb.auth.getSession();
      return (r.data && r.data.session) ? r.data.session.access_token : null;
    },
    onAuthStateChange: function(cb){
      if(!ready){ return { unsubscribe: function(){} }; }
      var sub = sb.auth.onAuthStateChange(function(event, session){
        cb(session ? session.user : null, event);
      });
      return sub.data ? sub.data.subscription : { unsubscribe: function(){} };
    },

    /* 購入状態 */
    isPurchased: async function(){
      if(!ready) return false;
      var u = await this.getUser();
      if(!u) return false;
      var bookId = await this.getBookId();
      if(!bookId) return false;
      var r = await sb.from('purchases').select('id')
              .eq('user_id', u.id).eq('book_id', bookId).maybeSingle();
      return !!(r.data && r.data.id);
    },

    /* この本の book_id をキャッシュして返す */
    _bookId: null,
    getBookId: async function(){
      if(this._bookId) return this._bookId;
      if(!ready) return null;
      var r = await sb.from('books').select('id').eq('slug', BOOK_SLUG).maybeSingle();
      this._bookId = r.data ? r.data.id : null;
      return this._bookId;
    },

    /* メモ */
    listMyNotes: async function(pageKey){
      if(!ready) return [];
      var u = await this.getUser();
      if(!u) return [];
      var bookId = await this.getBookId();
      var q = sb.from('notes').select('*').eq('user_id', u.id).eq('book_id', bookId);
      if(pageKey) q = q.eq('page_key', pageKey);
      var r = await q.order('created_at', { ascending: false });
      return r.data || [];
    },
    listPublicNotes: async function(pageKey){
      if(!ready) return [];
      var bookId = await this.getBookId();
      var r = await sb.from('notes').select('*, profiles(pen_name, display_name)')
              .eq('book_id', bookId).eq('page_key', pageKey).eq('is_public', true)
              .order('created_at', { ascending: false });
      return r.data || [];
    },
    saveNote: async function(pageKey, content, isPublic){
      if(!ready) return {error: {message:"offline"}};
      var u = await this.getUser();
      if(!u) return {error: {message:"not_signed_in"}};
      var bookId = await this.getBookId();
      return await sb.from('notes').insert({
        user_id: u.id, book_id: bookId,
        page_key: pageKey, content: content, is_public: !!isPublic
      });
    },
    deleteNote: async function(noteId){
      if(!ready) return {error:{message:"offline"}};
      return await sb.from('notes').delete().eq('id', noteId);
    }
  };

  /* index.html側のdelete handlerが直接呼べるよう、ショートカットを置く */
  window._sbDel = function(id){ return window.WEBON.deleteNote(id); };

  init();
})();
