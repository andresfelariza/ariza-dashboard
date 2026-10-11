/**
 * Copy to firebase-config.js and paste values from Firebase Console → Project settings → Your apps → Web.
 * Do NOT commit secrets beyond the public web config (apiKey is expected to be public; security is rules + E2E encryption).
 */
window.FIREBASE_CONFIG = {
  apiKey: "PASTE_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "PASTE",
  appId: "PASTE"
};

/** Long random id for this family's list doc (create once; share across devices). */
window.GROCERY_LIST_ID = "PASTE_A_LONG_RANDOM_ID";
