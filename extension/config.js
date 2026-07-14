// TruePin - deploy configuration (no build step, so this is a plain file).
// Every value is dormant-by-default: an empty string fully hides the matching
// footer button / support layer, so shipping with blanks is safe (no dead
// links, no network). Read as globals by popup.js and options.js.
const TP_EXTPAY_ID = ""; // extensionpay.com id (voluntary-support layer, options)
const TP_PAYPAL_URL = ""; // PayPal.me link for the popup donate button; empty = hidden
const TP_CWS_ID = ""; // Chrome Web Store item id (post-publish); empty = review hidden
const TP_REVIEW_URL = TP_CWS_ID
  ? `https://chromewebstore.google.com/detail/${TP_CWS_ID}/reviews`
  : "";
