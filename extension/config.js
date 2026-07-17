// TruePin - deploy configuration (no build step, so this is a plain file).
// Every value is dormant-by-default: an empty string fully hides the matching
// footer button, so shipping with blanks is safe (no dead links, no network).
// Read as globals by popup.js and options.js.
const TP_PAYPAL_URL = "https://www.paypal.com/donate/?hosted_button_id=88K7MWF22B2FU"; // PayPal Donate for the popup heart button; empty = hidden
const TP_CWS_ID = "fkgkfmhkdgpeopigpbgohoblocpjakcf"; // Chrome Web Store item id (post-publish); empty = review hidden
const TP_REVIEW_URL = TP_CWS_ID
  ? `https://chromewebstore.google.com/detail/truepin/${TP_CWS_ID}/reviews`
  : "";
const TP_GITHUB_URL = "https://github.com/datysho/truepin"; // repo to star; empty = hidden
