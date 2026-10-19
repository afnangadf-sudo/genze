// TOTP (otplib) singleton. window: 1 accepts one 30s step of clock skew
// either way — friendlier on real phones and keeps tests off step boundaries.

import { authenticator } from "otplib";

authenticator.options = { window: 1 };

export { authenticator };
