import { initializeApp } from 'firebase/app'
import { initializeAuth, GoogleAuthProvider, browserLocalPersistence } from 'firebase/auth'
import { initializeFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: "AIzaSyAzaLVT40gA9b42A8eeO56ojoXRo0khvE8",
  authDomain: "pomelo-55b25.firebaseapp.com",
  projectId: "pomelo-55b25",
  storageBucket: "pomelo-55b25.firebasestorage.app",
  messagingSenderId: "729743842077",
  appId: "1:729743842077:web:81a6e9a3e35a8190cddff4"
}

const app = initializeApp(firebaseConfig)

// Use localStorage for auth (faster than IndexedDB on iOS)
export const auth = initializeAuth(app, {
  persistence: browserLocalPersistence
})

// Use long-polling for Firestore (more reliable on iOS Safari)
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true
})

export const googleProvider = new GoogleAuthProvider()
