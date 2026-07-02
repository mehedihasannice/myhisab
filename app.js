import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js';
import {
  getDatabase, ref, get, set, remove, push,
  query, orderByChild, limitToLast, onValue
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js';

const firebaseConfig = {
  apiKey: "AIzaSyBmWURw03HyycLImNR-erXY_AAHY9jRDP0",
  authDomain: "my-hisab-d6f6d.firebaseapp.com",
  databaseURL: "https://my-hisab-d6f6d-default-rtdb.asia-southeast1.firebasedatabase.app/",
  projectId: "my-hisab-d6f6d"
};

// Worker test-এ যে URL confirm হয়েছিল সেটাই — বদলে গেলে এখানে বদলাও।
const WORKER_URL = "https://accounting-bot-parser.mehedihasan-nice96.workers.dev";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

function reportInitError(context, err) {
  console.error('[' + context + ']', err);
  const banner = document.createElement('div');
  banner.textContent = 'Setup error (' + context + '): ' + err.message;
  banner.style.cssText =
    'position:fixed;top:0;left:0;right:0;background:#DC2626;color:#fff;' +
    'padding:10px;text-align:center;font-size:12px;z-index:999;';
  document.body.appendChild(banner);
}

// --- Theme (day/night) — সম্পূর্ণ independent, data layer-এর সাথে সম্পর্ক নেই ---
(function initTheme() {
  try {
    const themeToggleBtn = document.getElementById('theme-toggle');
    const themeColorMeta = document.getElementById('theme-color-meta');
    if (!themeToggleBtn || !themeColorMeta) {
      throw new Error('theme-toggle বা theme-color-meta element পাওয়া যায়নি');
    }

    function getPreferredTheme() {
      try {
        const stored = localStorage.getItem('myhisab-theme');
        if (stored === 'light' || stored === 'dark') return stored;
      } catch (e) {}
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      themeToggleBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
      themeColorMeta.setAttribute('content', theme === 'dark' ? '#000000' : '#FFFFFF');
      try {
        localStorage.setItem('myhisab-theme', theme);
      } catch (e) {}
    }

    applyTheme(getPreferredTheme());
    themeToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });
  } catch (err) {
    reportInitError('theme', err);
  }
})();

// --- বাকি সব: auth, admin panel, ledger toggle, chat, confirm card ---
// এগুলো সব data layer-এর সাথে জড়িত (কোন ledger active তার উপর feed/save
// নির্ভর করে), তাই একটা block-এই রাখা হয়েছে।
(function initApp() {
  try {
    const authSection = document.getElementById('auth-section');
    const pendingSection = document.getElementById('pending-section');
    const appSection = document.getElementById('app-section');
    const adminPanel = document.getElementById('admin-panel');
    const pendingListEl = document.getElementById('pending-list');
    const tabPersonal = document.getElementById('tab-personal');
    const tabBusiness = document.getElementById('tab-business');
    const segmentIndicator = document.getElementById('segment-indicator');
    const chatFeed = document.getElementById('chat-feed');
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const chatSendBtn = document.getElementById('chat-send-btn');
    const confirmOverlay = document.getElementById('confirm-overlay');
    const confirmAmount = document.getElementById('confirm-amount');
    const confirmCategory = document.getElementById('confirm-category');
    const confirmDate = document.getElementById('confirm-date');
    const confirmNote = document.getElementById('confirm-note');
    const confirmTypeExpense = document.getElementById('confirm-type-expense');
    const confirmTypeIncome = document.getElementById('confirm-type-income');
    const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
    const confirmSaveBtn = document.getElementById('confirm-save-btn');

    if (!authSection || !pendingSection || !appSection || !adminPanel || !pendingListEl ||
        !tabPersonal || !tabBusiness || !segmentIndicator || !chatFeed || !chatForm ||
        !chatInput || !confirmOverlay) {
      throw new Error('মূল app-এর কোনো element পাওয়া যায়নি');
    }

    function showOnly(section) {
      [authSection, pendingSection, appSection].forEach(s => s.classList.add('hidden'));
      section.classList.remove('hidden');
    }

    function currentLedger() {
      return tabBusiness.classList.contains('active') ? 'business' : 'personal';
    }

    // ================= Admin: pending approvals =================
    async function loadPendingRequests() {
      pendingListEl.innerHTML = '';
      try {
        const snap = await get(ref(db, 'pendingRequests'));
        if (!snap.exists()) {
          const empty = document.createElement('div');
          empty.className = 'empty-note';
          empty.textContent = 'এখন কোনো pending request নেই।';
          pendingListEl.appendChild(empty);
          return;
        }
        const requests = snap.val();
        Object.keys(requests).forEach((uid) => {
          const r = requests[uid];
          const info = document.createElement('div');
          info.className = 'pending-item-info';
          info.appendChild(document.createTextNode(r.name));
          const emailSpan = document.createElement('span');
          emailSpan.className = 'email';
          emailSpan.textContent = r.email;
          info.appendChild(emailSpan);

          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'approve-btn';
          btn.textContent = 'Approve';
          btn.dataset.uid = uid;
          btn.dataset.name = r.name;

          const item = document.createElement('div');
          item.className = 'pending-item';
          item.appendChild(info);
          item.appendChild(btn);
          pendingListEl.appendChild(item);
        });
      } catch (err) {
        const errNote = document.createElement('div');
        errNote.className = 'empty-note';
        errNote.textContent = 'Load করতে সমস্যা হয়েছে।';
        pendingListEl.appendChild(errNote);
      }
    }

    pendingListEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.approve-btn');
      if (!btn) return;
      const uid = btn.dataset.uid;
      const name = btn.dataset.name;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await set(ref(db, `users/${uid}`), { name: name, role: 'member' });
        await remove(ref(db, `pendingRequests/${uid}`));
        loadPendingRequests();
      } catch (err) {
        alert('Approve করতে সমস্যা হয়েছে: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Approve';
      }
    });

    // ================= Chat feed =================
    let unsubscribeFeed = null;

    function subscribeToFeed(ledgerType, uid) {
      if (unsubscribeFeed) {
        unsubscribeFeed();
        unsubscribeFeed = null;
      }
      const path = ledgerType === 'personal' ? `personal/${uid}` : 'business';
      const q = query(ref(db, path), orderByChild('date'), limitToLast(50));
      unsubscribeFeed = onValue(q, (snapshot) => {
        renderFeed(snapshot);
      }, (err) => {
        chatFeed.innerHTML = '';
        const errNote = document.createElement('div');
        errNote.className = 'empty-note';
        errNote.textContent = 'হিসাব load করতে সমস্যা হয়েছে।';
        chatFeed.appendChild(errNote);
      });
    }

    function renderFeed(snapshot) {
      chatFeed.innerHTML = '';
      if (!snapshot.exists()) {
        const empty = document.createElement('div');
        empty.className = 'empty-note';
        empty.textContent = 'এখনো কোনো হিসাব যোগ হয়নি। নিচে লিখে শুরু করো।';
        chatFeed.appendChild(empty);
        return;
      }
      const entries = [];
      snapshot.forEach((child) => {
        entries.push(child.val());
      });
      entries.reverse();
      entries.forEach((entry) => chatFeed.appendChild(buildEntryEl(entry)));
    }

    function buildEntryEl(entry) {
      const item = document.createElement('div');
      item.className = 'entry-item ' + (entry.type === 'income' ? 'income' : 'expense');

      const main = document.createElement('div');
      main.className = 'entry-main';
      const catEl = document.createElement('span');
      catEl.className = 'entry-category';
      catEl.textContent = entry.category;
      const noteEl = document.createElement('span');
      noteEl.className = 'entry-note';
      noteEl.textContent = entry.note || '';
      main.appendChild(catEl);
      main.appendChild(noteEl);

      const amountEl = document.createElement('div');
      amountEl.className = 'entry-amount';
      amountEl.textContent = (entry.type === 'income' ? '+' : '-') + '৳' + entry.amount;

      item.appendChild(main);
      item.appendChild(amountEl);
      return item;
    }

    // ================= Personal/Business toggle =================
    tabPersonal.addEventListener('click', () => {
      if (tabPersonal.classList.contains('active')) return;
      tabPersonal.classList.add('active');
      tabBusiness.classList.remove('active');
      segmentIndicator.classList.remove('business');
      const user = auth.currentUser;
      if (user) subscribeToFeed('personal', user.uid);
    });
    tabBusiness.addEventListener('click', () => {
      if (tabBusiness.classList.contains('active')) return;
      tabBusiness.classList.add('active');
      tabPersonal.classList.remove('active');
      segmentIndicator.classList.add('business');
      const user = auth.currentUser;
      if (user) subscribeToFeed('business', user.uid);
    });

    // ================= Send message → Worker → confirm card =================
    let pendingLedger = null;

    chatForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (!text) return;

      chatInput.disabled = true;
      chatSendBtn.disabled = true;
      chatSendBtn.textContent = '...';

      try {
        const idToken = await auth.currentUser.getIdToken();
        const res = await fetch(WORKER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
          body: JSON.stringify({ text })
        });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || 'বুঝতে সমস্যা হয়েছে, আবার চেষ্টা করো।');
          return;
        }
        pendingLedger = currentLedger();
        confirmAmount.value = data.amount;
        confirmCategory.value = data.category;
        confirmDate.value = data.date;
        confirmNote.value = data.note || text;
        setConfirmType(data.type);
        confirmOverlay.classList.remove('hidden');
        chatInput.value = '';
      } catch (err) {
        alert('সমস্যা হয়েছে: ' + err.message);
      } finally {
        chatInput.disabled = false;
        chatSendBtn.disabled = false;
        chatSendBtn.textContent = '➤';
      }
    });

    function setConfirmType(type) {
      confirmTypeExpense.classList.toggle('active', type !== 'income');
      confirmTypeIncome.classList.toggle('active', type === 'income');
    }
    confirmTypeExpense.addEventListener('click', () => setConfirmType('expense'));
    confirmTypeIncome.addEventListener('click', () => setConfirmType('income'));

    confirmOverlay.addEventListener('click', (e) => {
      if (e.target === confirmOverlay) confirmOverlay.classList.add('hidden');
    });
    confirmCancelBtn.addEventListener('click', () => confirmOverlay.classList.add('hidden'));

    confirmSaveBtn.addEventListener('click', async () => {
      const amount = parseFloat(confirmAmount.value);
      const type = confirmTypeIncome.classList.contains('active') ? 'income' : 'expense';
      const category = confirmCategory.value.trim();
      const date = confirmDate.value;
      const note = confirmNote.value.trim();

      if (!amount || amount <= 0 || !category || !date) {
        alert('Amount, Category, আর Date ঠিকভাবে পূরণ করো।');
        return;
      }

      confirmSaveBtn.disabled = true;
      try {
        const user = auth.currentUser;
        const entry = { amount, type, category, date, note };
        if (pendingLedger === 'business') {
          entry.addedBy = user.uid;
          await set(push(ref(db, 'business')), entry);
        } else {
          await set(push(ref(db, `personal/${user.uid}`)), entry);
        }
        confirmOverlay.classList.add('hidden');
      } catch (err) {
        alert('সংরক্ষণ করতে সমস্যা হয়েছে: ' + err.message);
      } finally {
        confirmSaveBtn.disabled = false;
      }
    });

    // ================= Auth forms =================
    function friendlyAuthError(err) {
      const map = {
        'auth/invalid-email': 'Email format ঠিক নেই।',
        'auth/user-not-found': 'এই email দিয়ে কোনো account নেই।',
        'auth/wrong-password': 'Password ভুল হয়েছে।',
        'auth/invalid-credential': 'Email অথবা password ভুল।',
        'auth/email-already-in-use': 'এই email দিয়ে আগেই account আছে, login করো।',
        'auth/weak-password': 'Password কমপক্ষে ৬ character হতে হবে।',
        'auth/too-many-requests': 'অনেকবার চেষ্টা হয়েছে, একটু পর আবার চেষ্টা করো।'
      };
      return map[err.code] || ('সমস্যা হয়েছে: ' + err.message);
    }

    document.getElementById('show-signup-btn').addEventListener('click', () => {
      document.getElementById('login-form').classList.add('hidden');
      document.getElementById('signup-form').classList.remove('hidden');
    });
    document.getElementById('show-login-btn').addEventListener('click', () => {
      document.getElementById('signup-form').classList.add('hidden');
      document.getElementById('login-form').classList.remove('hidden');
    });

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      const errorEl = document.getElementById('login-error');
      errorEl.style.display = 'none';
      try {
        await signInWithEmailAndPassword(auth, email, password);
      } catch (err) {
        errorEl.textContent = friendlyAuthError(err);
        errorEl.style.display = 'block';
      }
    });

    document.getElementById('signup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('signup-name').value.trim();
      const email = document.getElementById('signup-email').value.trim();
      const password = document.getElementById('signup-password').value;
      const errorEl = document.getElementById('signup-error');
      errorEl.style.display = 'none';
      try {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await set(ref(db, `pendingRequests/${cred.user.uid}`), {
          name: name, email: email, requestedAt: Date.now()
        });
      } catch (err) {
        errorEl.textContent = friendlyAuthError(err);
        errorEl.style.display = 'block';
      }
    });

    document.getElementById('pending-logout-btn').addEventListener('click', () => signOut(auth));
    document.getElementById('app-logout-btn').addEventListener('click', () => signOut(auth));

    // ================= Auth state observer =================
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        if (unsubscribeFeed) { unsubscribeFeed(); unsubscribeFeed = null; }
        showOnly(authSection);
        return;
      }
      try {
        const snap = await get(ref(db, `users/${user.uid}`));
        if (snap.exists()) {
          const data = snap.val();
          const roleBadgeEl = document.getElementById('who-role');
          document.getElementById('who-name').textContent = data.name || user.email;
          roleBadgeEl.textContent = data.role === 'admin' ? 'Admin' : 'Member';
          roleBadgeEl.className = 'role-badge ' + (data.role === 'admin' ? 'admin' : 'member');
          showOnly(appSection);
          if (data.role === 'admin') {
            adminPanel.classList.remove('hidden');
            loadPendingRequests();
          } else {
            adminPanel.classList.add('hidden');
          }
          subscribeToFeed(currentLedger(), user.uid);
        } else {
          showOnly(pendingSection);
        }
      } catch (err) {
        showOnly(pendingSection);
      }
    });
  } catch (err) {
    reportInitError('app-core', err);
  }
})();
