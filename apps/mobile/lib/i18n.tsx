// Mobile language provider.
//
// Reuses the web dictionaries directly (apps/web/lib/i18n.ts is pure — no
// next.js imports — so it is imported relatively instead of copied). The
// same five UI languages, the same RTL set (ur/ar/fa), the same strings.
//
// Mobile-only copy lives in M_STRINGS below (same five languages, plain
// language, no technical words). Adding a UI language = one dictionary in
// the web lib + one M_STRINGS entry here.
//
// RTL: I18nManager.forceRTL is applied at boot from the saved language and
// again whenever the language changes; the root view also gets an explicit
// `direction` style so text flips immediately. A full native flip (system
// alerts, etc.) completes on the next app start — layouts here use flex and
// start/end alignment only, never left/right, so they stay correct either
// way.

import * as React from "react";
import { I18nManager, useColorScheme } from "react-native";
import * as SecureStore from "expo-secure-store";
import {
  LANGS,
  STRINGS,
  isLang,
  langDir,
  type Lang,
  type Strings,
} from "../../web/lib/i18n";
import { darkTheme, lightTheme, type Theme } from "./theme";

const UI_LANG_KEY = "genze_ui_lang";

type MobileStrings = Record<string, string>;

const M_STRINGS: Record<Lang, MobileStrings> = {
  en: {
    made_with_ai: "Made with AI",
    report: "Report",
    report_sent: "Thanks — we've received your report.",
    tab_voice: "Voice",
    tab_settings: "Settings",
    voice_title: "Voice",
    voice_tap_to_talk: "Tap to talk",
    voice_tap_to_talk_sub: "Speak, and Genze answers out loud.",
    voice_record_message: "Record a message",
    voice_record_message_sub: "Record a voice note and send it as a chat message.",
    voice_recording: "Recording… tap stop when you're done.",
    voice_listening: "Listening…",
    voice_working: "Working on your reply…",
    voice_speaking: "Speaking…",
    voice_stop: "Stop",
    voice_you_said: "You said",
    voice_no_mic: "Genze needs the microphone to hear you. Please allow it in your phone settings.",
    voice_start_new: "Start a new voice chat",
    coming_soon: "Coming soon to mobile",
    coming_soon_research: "Real research with sources is coming to the mobile app. You can use it on the web today.",
    coming_soon_write: "Writing drafts and styles are coming to the mobile app. You can use them on the web today.",
    coming_soon_studio: "Images, voice and video creation are coming to the mobile app. You can use them on the web today.",
    settings_language: "App language",
    settings_chat_language: "Chat language",
    settings_chat_language_hint: "Type any language code, e.g. es, fr, ps. Genze will reply in it.",
    settings_chat_language_saved: "Saved. New chats will use this language.",
    settings_chat_language_invalid: "That doesn't look like a language code.",
    settings_usage: "Usage",
    settings_usage_day: "Today",
    settings_usage_credits: "Credits",
    settings_usage_cost: "Cost today",
    settings_usage_unlimited: "Unlimited",
    settings_permissions: "AI permissions",
    settings_permissions_sub: "Choose which helpers can see your words.",
    settings_contact: "Contact us",
    settings_contact_sub: "Questions or problems? Write to us.",
    settings_delete: "Delete my account",
    settings_delete_sub: "This removes everything, forever. It can't be undone.",
    settings_delete_confirm_word: "Type DELETE to confirm",
    settings_delete_password: "Your password (skip if you signed in with Google or Apple)",
    settings_delete_no_password: "I signed in with Google or Apple (no password)",
    settings_delete_gone: "Your account is deleted. We're sorry to see you go.",
    settings_version: "App version",
    settings_sign_out: "Sign out",
    consent_first_title: "Before we begin",
    consent_first_sub: "Genze can think with the help of outside AI helpers. Each helper only sees what you send in that chat — nothing else. Pick who you'd like to use. You can change this anytime in Settings.",
    consent_continue: "Continue",
    consent_skip: "Skip for now",
    consent_demo_note: "No helpers are set up on this server yet, so Genze answers on its own and nothing leaves this phone's connection to the server.",
    consent_granted_all: "All set. You can change this anytime in Settings.",
    login_apple: "Continue with Apple",
    login_apple_unavailable: "Sign in with Apple isn't available on this device.",
    auth_or: "or",
    delete_type_delete: "Please type DELETE to confirm.",
    err_network: "Couldn't reach Genze. Check your connection and try again.",
    thread_new: "New chat",
    thread_empty: "No chats yet. Start one below.",
    chat_hint: "Write a message…",
    chat_send: "Send",
    chat_stop: "Stop",
    chat_thinking: "Thinking…",
    chat_consent_needed: "Genze needs your permission first.",
    chat_open_consent: "Choose helpers",
    library_search: "Search your library…",
    library_empty: "Nothing here yet.",
    ai_content_note: "Made with AI",
    verify_title: "Verify your email",
    verify_hint: "Paste the token from your email",
    verify_submit: "Verify",
    save: "Save",
    current: "Current",
    back: "Back",
  },
  ur: {
    made_with_ai: "AI سے بنایا گیا",
    report: "رپورٹ کریں",
    report_sent: "شکریہ — آپ کی رپورٹ موصول ہو گئی۔",
    tab_voice: "آواز",
    tab_settings: "ترتیبات",
    voice_title: "آواز",
    voice_tap_to_talk: "بات کرنے کے لیے دبائیں",
    voice_tap_to_talk_sub: "بولیں، اور Genze بلند آواز میں جواب دے گا۔",
    voice_record_message: "صوتی پیغام ریکارڈ کریں",
    voice_record_message_sub: "صوتی نوٹ ریکارڈ کریں اور چیٹ پیغام کے طور پر بھیجیں۔",
    voice_recording: "ریکارڈ ہو رہا ہے… مکمل ہونے پر روکیں دبائیں۔",
    voice_listening: "سن رہا ہے…",
    voice_working: "آپ کے جواب پر کام ہو رہا ہے…",
    voice_speaking: "بول رہا ہے…",
    voice_stop: "روکیں",
    voice_you_said: "آپ نے کہا",
    voice_no_mic: "آپ کو سننے کے لیے Genze کو مائیکروفون چاہیے۔ براہ کرم فون کی ترتیبات میں اجازت دیں۔",
    voice_start_new: "نئی صوتی چیٹ شروع کریں",
    coming_soon: "موبائل پر جلد آ رہا ہے",
    coming_soon_research: "ذرائع کے ساتھ اصل تحقیق موبائل ایپ میں جلد آ رہی ہے۔ آج آپ اسے ویب پر استعمال کر سکتے ہیں۔",
    coming_soon_write: "تحریری مسودے اور انداز موبائل ایپ میں جلد آ رہے ہیں۔ آج آپ انہیں ویب پر استعمال کر سکتے ہیں۔",
    coming_soon_studio: "تصاویر، آواز اور ویڈیو بنانا موبائل ایپ میں جلد آ رہا ہے۔ آج آپ اسے ویب پر استعمال کر سکتے ہیں۔",
    settings_language: "ایپ کی زبان",
    settings_chat_language: "چیٹ کی زبان",
    settings_chat_language_hint: "کوئی بھی زبان کا کوڈ لکھیں، مثلاً es، fr، ps۔ Genze اسی میں جواب دے گا۔",
    settings_chat_language_saved: "محفوظ ہو گیا۔ نئی چیٹس یہی زبان استعمال کریں گی۔",
    settings_chat_language_invalid: "یہ زبان کا کوڈ نہیں لگتا۔",
    settings_usage: "استعمال",
    settings_usage_day: "آج",
    settings_usage_credits: "کریڈٹس",
    settings_usage_cost: "آج کی لاگت",
    settings_usage_unlimited: "لامحدود",
    settings_permissions: "AI کی اجازتیں",
    settings_permissions_sub: "چنیں کہ کون سے مددگار آپ کے الفاظ دیکھ سکتے ہیں۔",
    settings_contact: "ہم سے رابطہ کریں",
    settings_contact_sub: "سوالات یا مسائل؟ ہمیں لکھیں۔",
    settings_delete: "میرا اکاؤنٹ حذف کریں",
    settings_delete_sub: "اس سے سب کچھ ہمیشہ کے لیے ختم ہو جائے گا۔ یہ واپس نہیں ہو سکتا۔",
    settings_delete_confirm_word: "تصدیق کے لیے DELETE لکھیں",
    settings_delete_password: "آپ کا پاس ورڈ (اگر Google یا Apple سے سائن ان کیا تو چھوڑ دیں)",
    settings_delete_no_password: "میں نے Google یا Apple سے سائن ان کیا تھا (پاس ورڈ نہیں)",
    settings_delete_gone: "آپ کا اکاؤنٹ حذف ہو گیا۔ آپ کے جانے کا افسوس ہے۔",
    settings_version: "ایپ کا ورژن",
    settings_sign_out: "سائن آؤٹ",
    consent_first_title: "شروع کرنے سے پہلے",
    consent_first_sub: "Genze بیرونی AI مددگاروں کی مدد سے سوچ سکتا ہے۔ ہر مددگار صرف وہی دیکھتا ہے جو آپ اس چیٹ میں بھیجتے ہیں — اور کچھ نہیں۔ چنیں کہ آپ کسے استعمال کرنا چاہتے ہیں۔ آپ یہ ترتیبات میں کسی بھی وقت بدل سکتے ہیں۔",
    consent_continue: "جاری رکھیں",
    consent_skip: "ابھی چھوڑ دیں",
    consent_demo_note: "اس سرور پر ابھی کوئی مددگار سیٹ نہیں، اس لیے Genze خود جواب دیتا ہے اور کچھ بھی سرور سے باہر نہیں جاتا۔",
    consent_granted_all: "ہو گیا۔ آپ یہ ترتیبات میں کسی بھی وقت بدل سکتے ہیں۔",
    login_apple: "Apple سے جاری رکھیں",
    login_apple_unavailable: "اس ڈیوائس پر Apple سے سائن ان دستیاب نہیں۔",
    auth_or: "یا",
    delete_type_delete: "تصدیق کے لیے DELETE لکھیں۔",
    err_network: "Genze سے رابطہ نہیں ہو سکا۔ اپنا کنکشن چیک کریں اور دوبارہ کوشش کریں۔",
    thread_new: "نئی چیٹ",
    thread_empty: "ابھی کوئی چیٹ نہیں۔ نیچے سے شروع کریں۔",
    chat_hint: "پیغام لکھیں…",
    chat_send: "بھیجیں",
    chat_stop: "روکیں",
    chat_thinking: "سوچ رہا ہے…",
    chat_consent_needed: "پہلے Genze کو آپ کی اجازت چاہیے۔",
    chat_open_consent: "مددگار چنیں",
    library_search: "اپنی لائبریری تلاش کریں…",
    library_empty: "ابھی یہاں کچھ نہیں۔",
    ai_content_note: "AI سے بنایا گیا",
    verify_title: "اپنی ای میل کی تصدیق کریں",
    verify_hint: "اپنی ای میل سے ٹوکن یہاں چسپاں کریں",
    verify_submit: "تصدیق کریں",
    save: "محفوظ کریں",
    current: "موجودہ",
    back: "واپس",
  },
  ar: {
    made_with_ai: "صُنع بالذكاء الاصطناعي",
    report: "الإبلاغ",
    report_sent: "شكرًا — استلمنا بلاغك.",
    tab_voice: "الصوت",
    tab_settings: "الإعدادات",
    voice_title: "الصوت",
    voice_tap_to_talk: "اضغط للتحدث",
    voice_tap_to_talk_sub: "تحدث، وسيرد عليك Genze بصوت عالٍ.",
    voice_record_message: "تسجيل رسالة صوتية",
    voice_record_message_sub: "سجّل ملاحظة صوتية وأرسلها كرسالة دردشة.",
    voice_recording: "جارٍ التسجيل… اضغط إيقاف عند الانتهاء.",
    voice_listening: "أستمع…",
    voice_working: "أجهّز ردّك…",
    voice_speaking: "أتحدث…",
    voice_stop: "إيقاف",
    voice_you_said: "قلت",
    voice_no_mic: "يحتاج Genze إلى الميكروفون ليسمعك. يرجى السماح بذلك في إعدادات هاتفك.",
    voice_start_new: "بدء دردشة صوتية جديدة",
    coming_soon: "قريبًا على الهاتف",
    coming_soon_research: "البحث الحقيقي بالمصادر قادم إلى تطبيق الهاتف. يمكنك استخدامه على الويب اليوم.",
    coming_soon_write: "مسودات الكتابة والأساليب قادمة إلى تطبيق الهاتف. يمكنك استخدامها على الويب اليوم.",
    coming_soon_studio: "إنشاء الصور والصوت والفيديو قادم إلى تطبيق الهاتف. يمكنك استخدامه على الويب اليوم.",
    settings_language: "لغة التطبيق",
    settings_chat_language: "لغة الدردشة",
    settings_chat_language_hint: "اكتب أي رمز لغة، مثل es أو fr أو ps. سيرد عليك Genze بها.",
    settings_chat_language_saved: "تم الحفظ. ستستخدم الدردشات الجديدة هذه اللغة.",
    settings_chat_language_invalid: "هذا لا يبدو رمز لغة.",
    settings_usage: "الاستخدام",
    settings_usage_day: "اليوم",
    settings_usage_credits: "الأرصدة",
    settings_usage_cost: "تكلفة اليوم",
    settings_usage_unlimited: "غير محدود",
    settings_permissions: "أذونات الذكاء الاصطناعي",
    settings_permissions_sub: "اختر المساعدين الذين يمكنهم رؤية كلماتك.",
    settings_contact: "اتصل بنا",
    settings_contact_sub: "أسئلة أو مشاكل؟ راسلنا.",
    settings_delete: "حذف حسابي",
    settings_delete_sub: "سيؤدي هذا إلى إزالة كل شيء للأبد. لا يمكن التراجع عنه.",
    settings_delete_confirm_word: "اكتب DELETE للتأكيد",
    settings_delete_password: "كلمة المرور (تجاوزها إذا سجلت الدخول عبر Google أو Apple)",
    settings_delete_no_password: "سجلت الدخول عبر Google أو Apple (لا كلمة مرور)",
    settings_delete_gone: "تم حذف حسابك. نأسف لرؤيتك ترحل.",
    settings_version: "إصدار التطبيق",
    settings_sign_out: "تسجيل الخروج",
    consent_first_title: "قبل أن نبدأ",
    consent_first_sub: "يمكن لـ Genze التفكير بمساعدة مساعدين خارجيين للذكاء الاصطناعي. كل مساعد يرى فقط ما ترسله في تلك الدردشة — لا شيء آخر. اختر من تريد استخدامه. يمكنك تغيير هذا في أي وقت من الإعدادات.",
    consent_continue: "متابعة",
    consent_skip: "تخطَّ الآن",
    consent_demo_note: "لم يتم إعداد أي مساعدين على هذا الخادم بعد، لذا يجيب Genze بنفسه ولا يغادر أي شيء الخادم.",
    consent_granted_all: "تم. يمكنك تغيير هذا في أي وقت من الإعدادات.",
    login_apple: "المتابعة مع Apple",
    login_apple_unavailable: "تسجيل الدخول مع Apple غير متاح على هذا الجهاز.",
    auth_or: "أو",
    delete_type_delete: "يرجى كتابة DELETE للتأكيد.",
    err_network: "تعذّر الوصول إلى Genze. تحقق من اتصالك وحاول مجددًا.",
    thread_new: "دردشة جديدة",
    thread_empty: "لا دردشات بعد. ابدأ واحدة أدناه.",
    chat_hint: "اكتب رسالة…",
    chat_send: "إرسال",
    chat_stop: "إيقاف",
    chat_thinking: "أفكّر…",
    chat_consent_needed: "يحتاج Genze إلى إذنك أولًا.",
    chat_open_consent: "اختيار المساعدين",
    library_search: "ابحث في مكتبتك…",
    library_empty: "لا شيء هنا بعد.",
    ai_content_note: "صُنع بالذكاء الاصطناعي",
    verify_title: "تحقق من بريدك الإلكتروني",
    verify_hint: "الصق الرمز من بريدك الإلكتروني",
    verify_submit: "تحقق",
    save: "حفظ",
    current: "الحالية",
    back: "رجوع",
  },
  tr: {
    made_with_ai: "YZ ile üretildi",
    report: "Bildir",
    report_sent: "Teşekkürler — bildiriminiz alındı.",
    tab_voice: "Ses",
    tab_settings: "Ayarlar",
    voice_title: "Ses",
    voice_tap_to_talk: "Konuşmak için dokun",
    voice_tap_to_talk_sub: "Konuşun, Genze sesli yanıt versin.",
    voice_record_message: "Sesli mesaj kaydet",
    voice_record_message_sub: "Sesli not kaydedip sohbet mesajı olarak gönderin.",
    voice_recording: "Kaydediliyor… bitince durdur'a dokunun.",
    voice_listening: "Dinleniyor…",
    voice_working: "Yanıtınız hazırlanıyor…",
    voice_speaking: "Konuşuluyor…",
    voice_stop: "Durdur",
    voice_you_said: "Dediniz ki",
    voice_no_mic: "Sizi duyabilmek için Genze'nin mikrofona ihtiyacı var. Lütfen telefon ayarlarınızdan izin verin.",
    voice_start_new: "Yeni sesli sohbet başlat",
    coming_soon: "Mobilde yakında",
    coming_soon_research: "Kaynaklı gerçek araştırma mobil uygulamaya geliyor. Bugün web'de kullanabilirsiniz.",
    coming_soon_write: "Yazı taslakları ve üsluplar mobil uygulamaya geliyor. Bugün web'de kullanabilirsiniz.",
    coming_soon_studio: "Görsel, ses ve video oluşturma mobil uygulamaya geliyor. Bugün web'de kullanabilirsiniz.",
    settings_language: "Uygulama dili",
    settings_chat_language: "Sohbet dili",
    settings_chat_language_hint: "Herhangi bir dil kodu yazın, örn. es, fr, ps. Genze o dilde yanıt verir.",
    settings_chat_language_saved: "Kaydedildi. Yeni sohbetler bu dili kullanacak.",
    settings_chat_language_invalid: "Bu bir dil koduna benzemiyor.",
    settings_usage: "Kullanım",
    settings_usage_day: "Bugün",
    settings_usage_credits: "Kredi",
    settings_usage_cost: "Bugünkü maliyet",
    settings_usage_unlimited: "Sınırsız",
    settings_permissions: "YZ izinleri",
    settings_permissions_sub: "Kelimelerinizi hangi yardımcıların görebileceğini seçin.",
    settings_contact: "Bize ulaşın",
    settings_contact_sub: "Soru veya sorun mu var? Bize yazın.",
    settings_delete: "Hesabımı sil",
    settings_delete_sub: "Bu, her şeyi sonsuza dek kaldırır. Geri alınamaz.",
    settings_delete_confirm_word: "Onaylamak için DELETE yazın",
    settings_delete_password: "Parolanız (Google veya Apple ile giriş yaptıysanız boş bırakın)",
    settings_delete_no_password: "Google veya Apple ile giriş yaptım (parola yok)",
    settings_delete_gone: "Hesabınız silindi. Aramızdan ayrıldığınıza üzüldük.",
    settings_version: "Uygulama sürümü",
    settings_sign_out: "Çıkış yap",
    consent_first_title: "Başlamadan önce",
    consent_first_sub: "Genze, dışarıdaki YZ yardımcılarının yardımıyla düşünebilir. Her yardımcı yalnızca o sohbette gönderdiklerinizi görür — başka bir şey değil. Kimi kullanmak istediğinizi seçin. Bunu Ayarlar'dan istediğiniz zaman değiştirebilirsiniz.",
    consent_continue: "Devam et",
    consent_skip: "Şimdilik geç",
    consent_demo_note: "Bu sunucuda henüz hiçbir yardımcı kurulu değil, bu yüzden Genze kendi başına yanıt verir ve hiçbir şey sunucudan dışarı çıkmaz.",
    consent_granted_all: "Tamamdır. Bunu Ayarlar'dan istediğiniz zaman değiştirebilirsiniz.",
    login_apple: "Apple ile devam et",
    login_apple_unavailable: "Apple ile giriş bu cihazda kullanılamıyor.",
    auth_or: "veya",
    delete_type_delete: "Onaylamak için lütfen DELETE yazın.",
    err_network: "Genze'ye ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.",
    thread_new: "Yeni sohbet",
    thread_empty: "Henüz sohbet yok. Aşağıdan başlatın.",
    chat_hint: "Bir mesaj yazın…",
    chat_send: "Gönder",
    chat_stop: "Durdur",
    chat_thinking: "Düşünülüyor…",
    chat_consent_needed: "Önce izninize ihtiyacı var.",
    chat_open_consent: "Yardımcıları seç",
    library_search: "Kitaplığınızda arayın…",
    library_empty: "Burada henüz bir şey yok.",
    ai_content_note: "YZ ile üretildi",
    verify_title: "E-postanızı doğrulayın",
    verify_hint: "E-postanızdaki jetonu yapıştırın",
    verify_submit: "Doğrula",
    save: "Kaydet",
    current: "Mevcut",
    back: "Geri",
  },
  fa: {
    made_with_ai: "ساخته‌شده با هوش مصنوعی",
    report: "گزارش",
    report_sent: "ممنون — گزارش شما دریافت شد.",
    tab_voice: "صدا",
    tab_settings: "تنظیمات",
    voice_title: "صدا",
    voice_tap_to_talk: "برای صحبت لمس کنید",
    voice_tap_to_talk_sub: "صحبت کنید، و Genze با صدای بلند پاسخ می‌دهد.",
    voice_record_message: "ضبط پیام صوتی",
    voice_record_message_sub: "یک یادداشت صوتی ضبط کنید و به‌عنوان پیام چت بفرستید.",
    voice_recording: "در حال ضبط… وقتی تمام شد توقف را لمس کنید.",
    voice_listening: "در حال گوش دادن…",
    voice_working: "در حال آماده‌سازی پاسخ شما…",
    voice_speaking: "در حال صحبت…",
    voice_stop: "توقف",
    voice_you_said: "شما گفتید",
    voice_no_mic: "Genze برای شنیدن شما به میکروفون نیاز دارد. لطفاً در تنظیمات گوشی اجازه دهید.",
    voice_start_new: "شروع چت صوتی جدید",
    coming_soon: "به‌زودی در موبایل",
    coming_soon_research: "پژوهش واقعی با منابع به اپ موبایل می‌آید. امروز می‌توانید آن را در وب استفاده کنید.",
    coming_soon_write: "پیش‌نویس‌ها و سبک‌های نوشتاری به اپ موبایل می‌آیند. امروز می‌توانید در وب استفاده کنید.",
    coming_soon_studio: "ساخت تصویر، صدا و ویدیو به اپ موبایل می‌آید. امروز می‌توانید در وب استفاده کنید.",
    settings_language: "زبان اپ",
    settings_chat_language: "زبان چت",
    settings_chat_language_hint: "هر کد زبانی را بنویسید، مثلاً es، fr، ps. Genze به همان زبان پاسخ می‌دهد.",
    settings_chat_language_saved: "ذخیره شد. چت‌های جدید از این زبان استفاده می‌کنند.",
    settings_chat_language_invalid: "این شبیه کد زبان نیست.",
    settings_usage: "مصرف",
    settings_usage_day: "امروز",
    settings_usage_credits: "اعتبار",
    settings_usage_cost: "هزینه امروز",
    settings_usage_unlimited: "نامحدود",
    settings_permissions: "مجوزهای هوش مصنوعی",
    settings_permissions_sub: "انتخاب کنید کدام دستیارها بتوانند حرف‌های شما را ببینند.",
    settings_contact: "تماس با ما",
    settings_contact_sub: "سؤال یا مشکلی دارید؟ برای ما بنویسید.",
    settings_delete: "حذف حساب من",
    settings_delete_sub: "این کار همه‌چیز را برای همیشه حذف می‌کند. قابل بازگشت نیست.",
    settings_delete_confirm_word: "برای تأیید DELETE را بنویسید",
    settings_delete_password: "گذرواژه شما (اگر با Google یا Apple وارد شدید رد کنید)",
    settings_delete_no_password: "با Google یا Apple وارد شدم (گذرواژه ندارم)",
    settings_delete_gone: "حساب شما حذف شد. از رفتن شما متأسفیم.",
    settings_version: "نسخه اپ",
    settings_sign_out: "خروج",
    consent_first_title: "پیش از شروع",
    consent_first_sub: "Genze می‌تواند با کمک دستیارهای بیرونی هوش مصنوعی فکر کند. هر دستیار فقط همان را می‌بیند که شما در آن چت می‌فرستید — نه چیز دیگر. انتخاب کنید از چه کسی استفاده شود. می‌توانید این را هر وقت در تنظیمات تغییر دهید.",
    consent_continue: "ادامه",
    consent_skip: "فعلاً رد شود",
    consent_demo_note: "هنوز هیچ دستیاری روی این سرور تنظیم نشده، پس Genze خودش پاسخ می‌دهد و چیزی از سرور خارج نمی‌شود.",
    consent_granted_all: "انجام شد. می‌توانید این را هر وقت در تنظیمات تغییر دهید.",
    login_apple: "ادامه با Apple",
    login_apple_unavailable: "ورود با Apple در این دستگاه در دسترس نیست.",
    auth_or: "یا",
    delete_type_delete: "لطفاً برای تأیيد DELETE را بنویسید.",
    err_network: "ارتباط با Genze برقرار نشد. اتصال خود را بررسی کنید و دوباره تلاش کنید.",
    thread_new: "چت جدید",
    thread_empty: "هنوز چتی نیست. از پایین شروع کنید.",
    chat_hint: "پیامی بنویسید…",
    chat_send: "ارسال",
    chat_stop: "توقف",
    chat_thinking: "در حال فکر…",
    chat_consent_needed: "اول به اجازه شما نیاز دارد.",
    chat_open_consent: "انتخاب دستیارها",
    library_search: "در کتابخانه خود جستجو کنید…",
    library_empty: "هنوز چیزی اینجا نیست.",
    ai_content_note: "ساخته‌شده با هوش مصنوعی",
    verify_title: "ایمیل خود را تأیید کنید",
    verify_hint: "توکن ایمیل خود را اینجا بچسبانید",
    verify_submit: "تأیید",
    save: "ذخیره",
    current: "فعلی",
    back: "بازگشت",
  },
};

export type MKey = keyof (typeof M_STRINGS)["en"];

interface LangContextValue {
  /** The web STRINGS dictionary for the current language (typed keys). */
  t: Strings;
  /** Mobile-only string lookup. */
  m: (key: MKey) => string;
  lang: Lang;
  setLang: (lang: Lang) => Promise<void>;
  rtl: boolean;
  theme: Theme;
}

const LangContext = React.createContext<LangContextValue | null>(null);

export function useLang(): LangContextValue {
  const ctx = React.useContext(LangContext);
  if (!ctx) throw new Error("useLang must be used inside LangProvider");
  return ctx;
}

function langFromCode(code: string | null): Lang {
  return code && isLang(code) ? code : "en";
}

export function LangProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const systemDark = useColorScheme() === "dark";
  const [lang, setLangState] = React.useState<Lang>("en");
  const [ready, setReady] = React.useState(false);

  // Boot: read the saved UI language and apply RTL before first paint of content.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await SecureStore.getItemAsync(UI_LANG_KEY);
        const next = langFromCode(saved);
        if (!cancelled) {
          setLangState(next);
          I18nManager.allowRTL(true);
          I18nManager.forceRTL(langDir(next) === "rtl");
        }
      } catch {
        /* storage unavailable — stay on English */
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setLang = React.useCallback(async (next: Lang) => {
    try {
      await SecureStore.setItemAsync(UI_LANG_KEY, next);
    } catch {
      /* storage unavailable */
    }
    setLangState(next);
    I18nManager.allowRTL(true);
    I18nManager.forceRTL(langDir(next) === "rtl");
  }, []);

  const rtl = langDir(lang) === "rtl";
  const theme = systemDark ? darkTheme : lightTheme;

  const value = React.useMemo<LangContextValue>(
    () => ({
      t: STRINGS[lang],
      m: (key: MKey) => M_STRINGS[lang][key] ?? M_STRINGS.en[key] ?? key,
      lang,
      setLang,
      rtl,
      theme,
    }),
    [lang, setLang, rtl, theme],
  );

  if (!ready) return <></>;
  // The explicit direction style flips text/layout immediately on language
  // change; forceRTL above covers native components on the next start.
  return (
    <LangContext.Provider value={value}>
      <React.Fragment>{children}</React.Fragment>
    </LangContext.Provider>
  );
}

/** Re-exported so screens don't import the web lib directly. */
export { LANGS, langDir, isLang };
export type { Lang };
