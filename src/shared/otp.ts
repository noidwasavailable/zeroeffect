// One-time passcode extraction for "copy the code" on OTP-labelled conversations. Heuristic and
// deliberately conservative: a code is only returned when it sits near an OTP keyword (or is the
// only code-shaped token in the subject), so ordinary numbers like prices or order IDs are skipped.

const KEYWORDS = [
  "verification code", "verification", "verify", "security code", "login code", "sign-in code", "sign in code",
  "one-time", "one time", "otp", "passcode", "pass code", "pin", "auth code", "authentication code",
  "confirmation code", "access code", "code",
  "인증번호", "인증 번호", "인증코드", "인증 코드", "확인 코드", "확인코드", "보안 코드", "보안코드", "승인번호", "코드",
  "認証コード", "確認コード", "验证码", "驗證碼",
] as const;

// 4-8 digits, optionally split once by a space or hyphen ("123 456") and optionally behind a
// "G-" style prefix. Letter-and-digit codes are left out: course codes, order IDs and product
// names look the same and are far more common in mail.
const CANDIDATE = /(?<![\w.,/:#-])(?:[A-Z]-)?(\d{3,4}[ -]\d{3,4}|\d{4,8})(?![\w/:%#-]|[.,]\d)/g;

/** How far (in characters) after a keyword a code may appear and still belong to it. */
const KEYWORD_WINDOW = 80;

const isLikelyNoise = (code: string, before: string): boolean => {
  if (/[$€£¥₩]\s*$/.test(before) || /(?:USD|KRW|EUR|원)\s*$/i.test(before)) return true;
  // Four-digit years are rarely codes.
  return /^(?:19|20)\d{2}$/.test(code);
};

const candidatesIn = (text: string): Array<{ readonly code: string; readonly index: number }> =>
  [...text.matchAll(CANDIDATE)]
    .map((match) => ({ code: match[1]!.replace(/[ -]/g, ""), index: match.index!, before: text.slice(Math.max(0, match.index! - 6), match.index!) }))
    .filter((candidate) => candidate.code.length >= 4 && candidate.code.length <= 8 && !isLikelyNoise(candidate.code, candidate.before));

/** Last whole-word occurrence of `keyword` starting before `end` (ASCII keywords must not sit inside a word, e.g. "pin" in "shipping"). */
const lastKeywordBefore = (lower: string, keyword: string, end: number): number => {
  const ascii = /^[\x20-\x7e]+$/.test(keyword);
  for (let at = lower.lastIndexOf(keyword, end); at >= 0; at = at === 0 ? -1 : lower.lastIndexOf(keyword, at - 1)) {
    if (!ascii) return at;
    const before = lower[at - 1] ?? " ";
    const after = lower[at + keyword.length] ?? " ";
    if (!/[a-z0-9]/.test(before) && !/[a-z]/.test(after)) return at;
  }
  return -1;
};

/** The code nearest after an OTP keyword in `text`, or null. */
const codeNearKeyword = (text: string): string | null => {
  const lower = text.toLowerCase();
  let best: { readonly code: string; readonly distance: number } | null = null;
  for (const candidate of candidatesIn(text)) {
    for (const keyword of KEYWORDS) {
      const keywordAt = lastKeywordBefore(lower, keyword, candidate.index);
      if (keywordAt < 0) continue;
      const distance = candidate.index - (keywordAt + keyword.length);
      if (distance >= 0 && distance <= KEYWORD_WINDOW && (!best || distance < best.distance)) best = { code: candidate.code, distance };
    }
  }
  return best?.code ?? null;
};

/** Extracts a one-time code from an email's subject and plain-text body, or null if none is clear. */
export const extractOtpCode = (subject: string, body: string): string | null => {
  const fromSubject = codeNearKeyword(subject);
  if (fromSubject) return fromSubject;
  const fromBody = codeNearKeyword(body.slice(0, 5_000));
  if (fromBody) return fromBody;
  // "123456 is your code" puts the code before the keyword; accept a lone code-shaped token in the subject.
  const subjectCandidates = candidatesIn(subject);
  return subjectCandidates.length === 1 ? subjectCandidates[0]!.code : null;
};

/**
 * Labels that mark a conversation as a one-time code: the LABEL actions of the account's OTP
 * rules (Inbox Zero's `systemType: "OTP"`), or "OTP" when no such rule exists.
 */
export const otpLabelNames = (
  rules: ReadonlyArray<{ readonly systemType: string | null; readonly actions: ReadonlyArray<{ readonly type: string; readonly label?: string | null }> }>,
): ReadonlySet<string> => {
  const labels = rules
    .filter((rule) => rule.systemType === "OTP")
    .flatMap((rule) => rule.actions.flatMap((action) => action.type === "LABEL" && action.label ? [action.label] : []));
  return new Set(labels.length > 0 ? labels : ["OTP"]);
};

/** The code to offer for copying: only on threads carrying an OTP label, so stray numbers elsewhere stay hidden. */
export const copyableOtp = (
  thread: { readonly otpCode: string | null; readonly labels: ReadonlyArray<string> },
  otpLabels: ReadonlySet<string>,
): string | null => thread.otpCode && thread.labels.some((label) => otpLabels.has(label)) ? thread.otpCode : null;
