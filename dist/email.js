// Outbound email. Zero-setup rule: when RESEND_API_KEY is unset the API must
// not fail — it prints a clearly-marked DEV EMAIL with the token link to the
// console instead. In NODE_ENV=test every email is also stashed in the
// in-memory outbox so tests can grab tokens without touching stdout.
import { loadConfig } from "./config.js";
/** Test hook: emails sent while NODE_ENV=test land here (in send order). */
export const testEmailOutbox = [];
export async function sendAuthEmail(kind, to, token) {
    const config = loadConfig();
    const link = kind === "verify"
        ? `${config.appUrl}/verify-email?token=${token}`
        : `${config.appUrl}/reset-password?token=${token}`;
    const subject = kind === "verify" ? "Verify your Genze email" : "Reset your Genze password";
    const text = kind === "verify"
        ? `Welcome to Genze!\n\nVerify your email address by opening this link (valid for 24 hours):\n${link}\n\nIf you didn't sign up, you can safely ignore this email.`
        : `You asked to reset your Genze password. Open this link (valid for 1 hour):\n${link}\n\nIf you didn't ask for this, you can safely ignore this email.`;
    if (process.env.NODE_ENV === "test") {
        testEmailOutbox.push({ to, subject, text });
    }
    if (config.resendApiKey) {
        try {
            const res = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${config.resendApiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ from: config.emailFrom, to, subject, text }),
            });
            if (!res.ok) {
                console.error(`[email] Resend rejected the message: ${res.status} ${await res.text()}`);
                logDevEmail(to, subject, text);
            }
        }
        catch (err) {
            console.error("[email] Resend request failed:", err);
            logDevEmail(to, subject, text);
        }
        return;
    }
    logDevEmail(to, subject, text);
}
function logDevEmail(to, subject, text) {
    console.log("\n================ DEV EMAIL ================");
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`\n${text}`);
    console.log("==========================================\n");
}
//# sourceMappingURL=email.js.map