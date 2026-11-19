
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";

import {
  getAuth
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";

import {
  getFirestore
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDF0nevgjmmSXN_vTRooiePILaeBwkWZK0",
  authDomain: "zeka-sorteo.firebaseapp.com",
  projectId: "zeka-sorteo",
  storageBucket: "zeka-sorteo.firebasestorage.app",
  messagingSenderId: "448909950881",
  appId: "1:448909950881:web:d8834583a38ac2aa3215e0"
};

const app = initializeApp(firebaseConfig);

const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };
