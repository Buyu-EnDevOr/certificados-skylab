/**
 * ============================================================================
 * 1. CONFIGURAÇÃO DO FIREBASE (OPCIONAL PARA TESTE LOCAL, PRONTO PARA NUVEM)
 * ============================================================================
 * Quando quiser ativar o login Google real na nuvem, crie um projeto no
 * console.firebase.google.com, ative Authentication (Google) e cole suas chaves:
 */
const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

/**
 * ============================================================================
 * 2. PADRÃO REATIVO SIGNALS (ZERO FRAMEWORK)
 * ============================================================================
 */
class Signal {
  #value;
  #subscribers = new Set();

  constructor(initialValue) {
    this.#value = initialValue;
  }

  get value() {
    return this.#value;
  }

  set value(newValue) {
    this.#value = newValue;
    this.#subscribers.forEach((fn) => fn(newValue));
  }

  subscribe(fn) {
    this.#subscribers.add(fn);
    fn(this.#value);
    return () => this.#subscribers.delete(fn);
  }
}

/**
 * ============================================================================
 * 3. BANCO DE DADOS INDEXEDDB (SUPORTA PDFs E IMAGENS GRANDES NO NAVEGADOR)
 * ============================================================================
 */
const DB_NAME = "ChronosAcademicDB";
const DB_VERSION = 1;
const STORE_CERTS = "certificates";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_CERTS)) {
        db.createObjectStore(STORE_CERTS, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGetAllCertificates(userId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CERTS, "readonly");
    const store = tx.objectStore(STORE_CERTS);
    const req = store.getAll();
    req.onsuccess = () => {
      const all = req.result || [];
      resolve(
        all
          .filter((item) => item.userId === userId)
          .sort((a, b) => b.createdAt - a.createdAt)
      );
    };
    req.onerror = () => reject(req.error);
  });
}

async function dbSaveCertificate(certData) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CERTS, "readwrite");
    tx.objectStore(STORE_CERTS).put(certData);
    tx.oncomplete = () => resolve(certData);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDeleteCertificate(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CERTS, "readwrite");
    tx.objectStore(STORE_CERTS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * ============================================================================
 * 4. ESTADO DA APLICAÇÃO
 * ============================================================================
 */
const userSignal = new Signal(JSON.parse(localStorage.getItem("chronos_user") || "null"));
const quotaSignal = new Signal(Number(localStorage.getItem("chronos_quota") || 200));
const certsSignal = new Signal([]);
const searchSignal = new Signal("");

// Elementos da DOM
const authView = document.getElementById("auth-view");
const appView = document.getElementById("app-view");
const btnGoogleLogin = document.getElementById("btn-google-login");
const btnLogout = document.getElementById("btn-logout");
const userDisplayEmail = document.getElementById("user-display-email");
const envStatus = document.getElementById("env-status");

// Métricas e Gráfico
const headerQuotaVal = document.getElementById("header-quota-val");
const ringProgress = document.getElementById("ring-progress");
const chartPercent = document.getElementById("chart-percent");
const statDone = document.getElementById("stat-done");
const statLeft = document.getElementById("stat-left");
const statTotal = document.getElementById("stat-total");
const statusBadge = document.getElementById("status-badge");

// Formulário e Upload
const certForm = document.getElementById("cert-form");
const certFileInput = document.getElementById("cert-file");
const dropzoneText = document.getElementById("dropzone-text");
const vaultGrid = document.getElementById("vault-grid");
const searchInput = document.getElementById("search-input");

// Modal de Cota
const quotaModal = document.getElementById("quota-modal");
const quotaForm = document.getElementById("quota-form");
const inputQuota = document.getElementById("input-quota");
const btnOpenQuota = document.getElementById("btn-open-quota");
const btnCloseModal = document.getElementById("btn-close-modal");

const CIRCUMFERENCE = 2 * Math.PI * 92; // r = 92

/**
 * ============================================================================
 * 5. AUTENTICAÇÃO (FIREBASE GOOGLE OU FALLBACK LOCAL)
 * ============================================================================
 */
const isFirebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

if (isFirebaseConfigured) {
  envStatus.textContent = "Conectado ao Firebase Auth";
}

btnGoogleLogin.addEventListener("click", async () => {
  if (isFirebaseConfigured) {
    try {
      const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
      const { getAuth, signInWithPopup, GoogleAuthProvider } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
      const app = initializeApp(firebaseConfig);
      const auth = getAuth(app);
      const result = await signInWithPopup(auth, new GoogleAuthProvider());
      loginSuccess({
        uid: result.user.uid,
        name: result.user.displayName,
        email: result.user.email
      });
    } catch (err) {
      alert("Erro ao autenticar no Firebase: " + err.message);
    }
  } else {
    // Login local instantâneo para desenvolvimento no VS Code
    loginSuccess({
      uid: "local-student-01",
      name: "Estudante Universitário",
      email: "estudante@universidade.edu.br"
    });
  }
});

function loginSuccess(userData) {
  localStorage.setItem("chronos_user", JSON.stringify(userData));
  userSignal.value = userData;
}

btnLogout.addEventListener("click", () => {
  localStorage.removeItem("chronos_user");
  userSignal.value = null;
});

/**
 * ============================================================================
 * 6. REATIVIDADE DE UI (ASSINATURAS DOS SIGNALS)
 * ============================================================================
 */
userSignal.subscribe(async (user) => {
  if (!user) {
    authView.hidden = false;
    appView.hidden = true;
    certsSignal.value = [];
    return;
  }

  authView.hidden = true;
  appView.hidden = false;
  userDisplayEmail.textContent = user.email;
  certsSignal.value = await dbGetAllCertificates(user.uid);
});

function updateDashboardMetrics() {
  const quota = quotaSignal.value;
  const certs = certsSignal.value;
  const completedHours = certs.reduce((sum, item) => sum + Number(item.hours), 0);
  const remainingHours = Math.max(quota - completedHours, 0);
  const rawPercent = quota > 0 ? Math.round((completedHours / quota) * 100) : 0;
  const clampedPercent = Math.min(rawPercent, 100);

  // Atualiza textos
  headerQuotaVal.textContent = `${quota}h`;
  statDone.textContent = `${completedHours}h`;
  statLeft.textContent = `${remainingHours}h`;
  statTotal.textContent = `${quota}h`;
  chartPercent.textContent = `${rawPercent}%`;

  // Atualiza anel SVG
  const offset = CIRCUMFERENCE - (clampedPercent / 100) * CIRCUMFERENCE;
  ringProgress.style.strokeDashoffset = offset;

  // Atualiza status da cota
  if (completedHours >= quota) {
    statusBadge.textContent = "Cota Concluída!";
    statusBadge.classList.add("badge--done");
  } else {
    statusBadge.textContent = `Faltam ${remainingHours}h`;
    statusBadge.classList.remove("badge--done");
  }
}

function renderVaultList() {
  const query = searchSignal.value.trim().toLowerCase();
  const filtered = certsSignal.value.filter(
    (c) =>
      c.name.toLowerCase().includes(query) ||
      c.category.toLowerCase().includes(query) ||
      c.fileName.toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    vaultGrid.innerHTML = `
      <div class="text-dim" style="grid-column: 1 / -1; text-align: center; padding: 32px 16px;">
        Nenhum certificado encontrado no cofre. Adicione seu primeiro comprovante acima!
      </div>
    `;
    return;
  }

  vaultGrid.innerHTML = filtered
    .map(
      (cert) => `
      <article class="cert-item" role="listitem">
        <div>
          <div class="cert-item__meta">
            <span class="badge">${escapeHtml(cert.category)}</span>
            <strong class="mono-text text-cyan">+${Number(cert.hours)}h</strong>
          </div>
          <h4 class="cert-item__title">${escapeHtml(cert.name)}</h4>
          <p class="cert-item__file truncate" title="${escapeHtml(cert.fileName)}">
            <i class="ph ph-file-text"></i> ${escapeHtml(cert.fileName)}
          </p>
        </div>

        <div class="cert-item__actions">
          <button type="button" class="btn btn--ghost" style="flex: 1;" data-action="download" data-id="${cert.id}">
            <i class="ph-bold ph-download-simple"></i>
            <span>Baixar</span>
          </button>
          <button type="button" class="btn btn--icon" data-action="delete" data-id="${cert.id}" title="Excluir certificado" aria-label="Excluir certificado">
            <i class="ph ph-trash"></i>
          </button>
        </div>
      </article>
    `
    )
    .join("");
}

quotaSignal.subscribe(() => updateDashboardMetrics());
certsSignal.subscribe(() => {
  updateDashboardMetrics();
  renderVaultList();
});
searchSignal.subscribe(() => renderVaultList());

/**
 * ============================================================================
 * 7. EVENTOS DE FORMULÁRIO, UPLOAD E DOWNLOAD DE ARQUIVOS
 * ============================================================================
 */
certFileInput.addEventListener("change", () => {
  const file = certFileInput.files[0];
  if (file) {
    dropzoneText.textContent = `Arquivo selecionado: ${file.name}`;
  } else {
    dropzoneText.textContent = "Toque para anexar ou arraste o certificado";
  }
});

certForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const user = userSignal.value;
  if (!user) return;

  const nameInput = document.getElementById("cert-name");
  const categoryInput = document.getElementById("cert-category");
  const hoursInput = document.getElementById("cert-hours");
  const file = certFileInput.files[0];

  const hours = Number(hoursInput.value);
  if (!file || hours <= 0) return;

  const newCert = {
    id: crypto.randomUUID(),
    userId: user.uid,
    name: nameInput.value.trim(),
    category: categoryInput.value,
    hours,
    fileName: file.name,
    fileType: file.type || "application/octet-stream",
    fileBlob: file, // Salva o Blob nativo no IndexedDB
    createdAt: Date.now()
  };

  // Optimistic UI update + Persistência IndexedDB
  await dbSaveCertificate(newCert);
  certsSignal.value = [newCert, ...certsSignal.value];

  certForm.reset();
  dropzoneText.textContent = "Toque para anexar ou arraste o certificado";
});

// Delegação de eventos para Download e Exclusão no Cofre
vaultGrid.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;

  const { action, id } = btn.dataset;
  const targetCert = certsSignal.value.find((c) => c.id === id);
  if (!targetCert) return;

  if (action === "download") {
    const blobUrl = URL.createObjectURL(targetCert.fileBlob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = targetCert.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 3000);
  }

  if (action === "delete") {
    await dbDeleteCertificate(id);
    certsSignal.value = certsSignal.value.filter((c) => c.id !== id);
  }
});

// Modal de Edição da Cota da Faculdade
btnOpenQuota.addEventListener("click", () => {
  inputQuota.value = quotaSignal.value;
  quotaModal.showModal();
});

btnCloseModal.addEventListener("click", () => quotaModal.close());

quotaForm.addEventListener("submit", () => {
  const newQuota = Number(inputQuota.value);
  if (newQuota >= 10) {
    localStorage.setItem("chronos_quota", String(newQuota));
    quotaSignal.value = newQuota;
  }
});

// Busca com Debounce de 150ms para performance de INP
let searchTimer;
searchInput.addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchSignal.value = e.target.value;
  }, 150);
});

// Sanitização contra XSS
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}