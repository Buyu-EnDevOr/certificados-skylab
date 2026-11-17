/**
 * ============================================================================
 * 1. CONFIGURAÇÃO DO FIREBASE (COLE SUAS CHAVES AQUI)
 * ============================================================================
 */
const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

const isFirebaseReady = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

/**
 * ============================================================================
 * 2. CRIPTOGRAFIA CLIENT-SIDE (WEB CRYPTO API AES-GCM 256 + SHA-256)
 * ============================================================================
 * Garante que mesmo no banco de dados os dados sensíveis fiquem criptografados
 * com uma chave derivada exclusivamente do UID do usuário.
 */
async function deriveUserKey(uid) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(uid + "_CHRONOS_OBSIDIAN_SALT_2026"),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode("chronos-academic-vault"),
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptPayload(uid, plainObj) {
  const key = await deriveUserKey(uid);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(plainObj));
  const cipherBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  return {
    cipherText: btoa(String.fromCharCode(...new Uint8Array(cipherBuffer))),
    iv: btoa(String.fromCharCode(...iv))
  };
}

async function decryptPayload(uid, cipherText, ivBase64) {
  try {
    const key = await deriveUserKey(uid);
    const iv = Uint8Array.from(atob(ivBase64), (c) => c.charCodeAt(0));
    const cipherBytes = Uint8Array.from(atob(cipherText), (c) => c.charCodeAt(0));
    const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);
    return JSON.parse(new TextDecoder().decode(decryptedBuffer));
  } catch {
    return { name: "Certificado Protegido", fileName: "comprovante.pdf" };
  }
}

async function computeFileHash(fileBlob) {
  const buffer = await fileBlob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * ============================================================================
 * 3. BANCO LOCAL INDEXEDDB (ARMAZENA OS PDFS/IMAGENS SEM USAR FIREBASE STORAGE)
 * ============================================================================
 */
const DB_NAME = "ChronosObsidianDB";
const STORE_CERTS = "certificates";

function openLocalDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_CERTS)) {
        db.createObjectStore(STORE_CERTS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveLocalCert(cert) {
  const db = await openLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CERTS, "readwrite");
    tx.objectStore(STORE_CERTS).put(cert);
    tx.oncomplete = () => resolve(cert);
    tx.onerror = () => reject(tx.error);
  });
}

async function getLocalCerts(userId) {
  const db = await openLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CERTS, "readonly");
    const req = tx.objectStore(STORE_CERTS).getAll();
    req.onsuccess = () => {
      const list = (req.result || []).filter((c) => c.userId === userId);
      resolve(list.sort((a, b) => b.createdAt - a.createdAt));
    };
    req.onerror = () => reject(req.error);
  });
}

async function deleteLocalCert(id) {
  const db = await openLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CERTS, "readwrite");
    tx.objectStore(STORE_CERTS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * ============================================================================
 * 4. INTEGRAÇÃO COM O OBSIDIAN (VAULT FOLDER SYNC + GERADOR MARKDOWN + URI)
 * ============================================================================
 */
let obsidianVaultHandle = null;

function generateObsidianMarkdown(cert, profile) {
  const dateIso = new Date(cert.createdAt).toISOString().split("T")[0];
  return [
    "---",
    `titulo: "${cert.name.replace(/"/g, '\\"')}"`,
    `categoria: "${cert.category}"`,
    `horas: ${cert.hours}`,
    `curso: "${profile.course}"`,
    `cota_curso: ${profile.quota}`,
    `data_registro: ${dateIso}`,
    `sha256: "${cert.sha256}"`,
    `tags: [horas-complementares, ${cert.category.toLowerCase()}]`,
    "---",
    "",
    `# ${cert.name}`,
    "",
    `- **Categoria:** ${cert.category}`,
    `- **Carga Horária Computada:** \`${cert.hours}h\``,
    `- **Arquivo Original:** \`${cert.fileName}\``,
    `- **Hash de Integridade (SHA-256):** \`${cert.sha256}\``,
    "",
    "## Comprovante Anexado",
    `![[Anexos/${cert.fileName}]]`,
    ""
  ].join("\n");
}

async function syncCertificateToObsidianFolder(cert, profile, allCerts) {
  if (!obsidianVaultHandle) return false;

  try {
    // 1. Cria subpasta "Horas_Complementares" e "Anexos" dentro do Vault do Obsidian
    const rootFolder = await obsidianVaultHandle.getDirectoryHandle("Horas_Complementares", { create: true });
    const attachFolder = await rootFolder.getDirectoryHandle("Anexos", { create: true });

    // 2. Salva o PDF/Imagem físico dentro de Horas_Complementares/Anexos/
    if (cert.fileBlob) {
      const fileHandle = await attachFolder.getFileHandle(cert.fileName, { create: true });
      const writableFile = await fileHandle.createWritable();
      await writableFile.write(cert.fileBlob);
      await writableFile.close();
    }

    // 3. Cria a Nota Markdown (.md) do Certificado com Frontmatter YAML
    const safeTitle = cert.name.replace(/[\\/:*?"<>|]/g, "-");
    const mdFileName = `${safeTitle}.md`;
    const mdHandle = await rootFolder.getFileHandle(mdFileName, { create: true });
    const writableMd = await mdHandle.createWritable();
    await writableMd.write(generateObsidianMarkdown(cert, profile));
    await writableMd.close();

    // 4. Atualiza a nota "_Painel_Horas.md" no Obsidian com o resumo geral
    await updateObsidianDashboardNote(rootFolder, profile, allCerts);
    return true;
  } catch (err) {
    console.warn("Não foi possível gravar direto na pasta do Obsidian:", err);
    return false;
  }
}

async function updateObsidianDashboardNote(rootFolder, profile, allCerts) {
  const doneHours = allCerts.reduce((acc, c) => acc + Number(c.hours), 0);
  const leftHours = Math.max(profile.quota - doneHours, 0);
  const percent = profile.quota > 0 ? Math.min(Math.round((doneHours / profile.quota) * 100), 100) : 0;

  const rows = allCerts
    .map((c) => `| [[${c.name.replace(/[\\/:*?"<>|]/g, "-")}]] | ${c.category} | +${c.hours}h | \`${c.fileName}\` |`)
    .join("\n");

  const dashboardMd = [
    "---",
    `curso: "${profile.course}"`,
    `cota_total: ${profile.quota}`,
    `horas_concluidas: ${doneHours}`,
    `horas_restantes: ${leftHours}`,
    `progresso: "${percent}%"`,
    "---",
    "",
    `# Painel de Horas Complementares — ${profile.course}`,
    "",
    `> **Progresso:** ${doneHours}h de ${profile.quota}h concluídas (${percent}%) — **Faltam ${leftHours}h**`,
    "",
    "| Certificado | Categoria | Horas | Arquivo |",
    "| :--- | :--- | :---: | :--- |",
    rows || "| _Nenhum certificado cadastrado_ | - | 0h | - |",
    ""
  ].join("\n");

  const dashHandle = await rootFolder.getFileHandle("_Painel_Horas.md", { create: true });
  const writable = await dashHandle.createWritable();
  await writable.write(dashboardMd);
  await writable.close();
}

/**
 * ============================================================================
 * 5. CONEXÃO COM FIREBASE AUTH + FIRESTORE
 * ============================================================================
 */
let fbApp = null;
let fbAuth = null;
let fbDb = null;

async function initFirebaseModules() {
  if (!isFirebaseReady) return null;
  if (fbApp) return { fbAuth, fbDb };

  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
  const { getAuth } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  const { getFirestore } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

  fbApp = initializeApp(firebaseConfig);
  fbAuth = getAuth(fbApp);
  fbDb = getFirestore(fbApp);
  return { fbAuth, fbDb };
}

async function authenticateWithGoogle(registrationMeta = null) {
  if (isFirebaseReady) {
    const { GoogleAuthProvider, signInWithPopup } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
    const { doc, getDoc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const { fbAuth, fbDb } = await initFirebaseModules();

    const result = await signInWithPopup(fbAuth, new GoogleAuthProvider());
    const user = result.user;
    const userRef = doc(fbDb, "users", user.uid);
    const snap = await getDoc(userRef);

    let profile = {
      uid: user.uid,
      name: user.displayName || "Estudante",
      email: user.email,
      course: registrationMeta?.course || "Administração - UFSJ",
      vaultName: registrationMeta?.vaultName || "Faculdade",
      quota: Number(registrationMeta?.quota || 200),
      updatedAt: Date.now()
    };

    if (snap.exists() && !registrationMeta) {
      profile = { ...profile, ...snap.data() };
    } else {
      await setDoc(userRef, {
        course: profile.course,
        vaultName: profile.vaultName,
        quota: profile.quota,
        updatedAt: Date.now()
      }, { merge: true });
    }

    localStorage.setItem("chronos_user", JSON.stringify(profile));
    window.location.href = "index.html";
  } else {
    // Fallback Local imediato para testar no VS Code antes de colar as chaves
    const savedProfile = JSON.parse(localStorage.getItem("chronos_user") || "null");
    const profile = {
      uid: "local-student-ufsj",
      name: "Estudante Universitário",
      email: "estudante@ufsj.edu.br",
      course: registrationMeta?.course || savedProfile?.course || "Administração - UFSJ",
      vaultName: registrationMeta?.vaultName || savedProfile?.vaultName || "Faculdade",
      quota: Number(registrationMeta?.quota || savedProfile?.quota || 200)
    };
    localStorage.setItem("chronos_user", JSON.stringify(profile));
    window.location.href = "index.html";
  }
}

/**
 * ============================================================================
 * 6. ROTEAMENTO POR PÁGINA (login.html | cadastro.html | index.html)
 * ============================================================================
 */
const currentPage = document.body.dataset.page;
const envStatusEl = document.getElementById("env-status");

if (envStatusEl) {
  envStatusEl.textContent = isFirebaseReady
    ? "Firebase Auth + Criptografia AES-GCM Ativos"
    : "Modo Local VS Code Ativo (cole seu firebaseConfig no app.js para nuvem)";
}

if (currentPage === "login") {
  const btnLogin = document.getElementById("btn-google-login");
  const alertBox = document.getElementById("auth-alert");

  btnLogin.addEventListener("click", async () => {
    try {
      alertBox.hidden = true;
      await authenticateWithGoogle(null);
    } catch (err) {
      alertBox.hidden = false;
      alertBox.textContent = `Erro no login (${err.code || "Auth"}): verifique os domínios autorizados no Firebase.`;
    }
  });
}

if (currentPage === "register") {
  const regForm = document.getElementById("register-form");
  const alertBox = document.getElementById("auth-alert");

  regForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const course = document.getElementById("reg-course").value.trim();
    const vaultName = document.getElementById("reg-vault").value.trim();
    const quota = Number(document.getElementById("reg-quota").value);

    try {
      alertBox.hidden = true;
      await authenticateWithGoogle({ course, vaultName, quota });
    } catch (err) {
      alertBox.hidden = false;
      alertBox.textContent = `Erro ao cadastrar (${err.code || "Auth"}): verifique os domínios autorizados no Firebase.`;
    }
  });
}

if (currentPage === "dashboard") {
  initDashboard();
}

/**
 * ============================================================================
 * 7. CONTROLADOR DO DASHBOARD (index.html)
 * ============================================================================
 */
async function initDashboard() {
  const profile = JSON.parse(localStorage.getItem("chronos_user") || "null");
  if (!profile) {
    window.location.href = "login.html";
    return;
  }

  // Referências DOM
  const courseTitle = document.getElementById("user-course-title");
  const emailSubtitle = document.getElementById("user-display-email");
  const headerQuotaVal = document.getElementById("header-quota-val");
  const ringProgress = document.getElementById("ring-progress");
  const chartPercent = document.getElementById("chart-percent");
  const statDone = document.getElementById("stat-done");
  const statLeft = document.getElementById("stat-left");
  const statTotal = document.getElementById("stat-total");
  const statusBadge = document.getElementById("status-badge");
  const vaultGrid = document.getElementById("vault-grid");
  const searchInput = document.getElementById("search-input");

  const certForm = document.getElementById("cert-form");
  const certFileInput = document.getElementById("cert-file");
  const dropzoneText = document.getElementById("dropzone-text");
  const btnLinkObsidian = document.getElementById("btn-link-obsidian");
  const obsidianStatusText = document.getElementById("obsidian-status-text");

  const quotaModal = document.getElementById("quota-modal");
  const quotaForm = document.getElementById("quota-form");
  const btnOpenQuota = document.getElementById("btn-open-quota");
  const btnCloseModal = document.getElementById("btn-close-modal");
  const btnLogout = document.getElementById("btn-logout");

  const CIRCUMFERENCE = 2 * Math.PI * 92;
  let certificates = await getLocalCerts(profile.uid);
  let searchQuery = "";

  // Sincroniza metadados criptografados do Firestore (se configurado)
  if (isFirebaseReady) {
    try {
      const { collection, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
      const { fbDb } = await initFirebaseModules();
      const snap = await getDocs(collection(fbDb, "users", profile.uid, "certificates"));
      const localIds = new Set(certificates.map((c) => c.id));

      for (const docSnap of snap.docs) {
        if (!localIds.has(docSnap.id)) {
          const data = docSnap.data();
          const decrypted = await decryptPayload(profile.uid, data.cipherText, data.iv);
          certificates.push({
            id: docSnap.id,
            userId: profile.uid,
            name: decrypted.name,
            fileName: decrypted.fileName,
            category: data.category,
            hours: data.hours,
            sha256: data.sha256,
            createdAt: data.createdAt,
            fileBlob: null // Metadado vindo da nuvem/Obsidian
          });
        }
      }
      certificates.sort((a, b) => b.createdAt - a.createdAt);
    } catch (e) {
      console.warn("Modo offline local ativo:", e);
    }
  }

  function renderUI() {
    courseTitle.textContent = profile.course || "Chronos Acadêmico";
    emailSubtitle.textContent = `${profile.email} • Vault: ${profile.vaultName || "Faculdade"}`;

    const quota = Number(profile.quota) || 200;
    const done = certificates.reduce((sum, c) => sum + Number(c.hours), 0);
    const left = Math.max(quota - done, 0);
    const rawPct = quota > 0 ? Math.round((done / quota) * 100) : 0;
    const clampedPct = Math.min(rawPct, 100);

    headerQuotaVal.textContent = `${quota}h`;
    statDone.textContent = `${done}h`;
    statLeft.textContent = `${left}h`;
    statTotal.textContent = `${quota}h`;
    chartPercent.textContent = `${rawPct}%`;

    ringProgress.style.strokeDashoffset = CIRCUMFERENCE - (clampedPct / 100) * CIRCUMFERENCE;

    if (done >= quota) {
      statusBadge.textContent = "Cota Concluída!";
      statusBadge.classList.add("badge--done");
    } else {
      statusBadge.textContent = `Faltam ${left}h`;
      statusBadge.classList.remove("badge--done");
    }

    const filtered = certificates.filter(
      (c) =>
        c.name.toLowerCase().includes(searchQuery) ||
        c.category.toLowerCase().includes(searchQuery) ||
        c.fileName.toLowerCase().includes(searchQuery)
    );

    if (filtered.length === 0) {
      vaultGrid.innerHTML = `
        <div class="text-dim" style="grid-column: 1 / -1; text-align: center; padding: 32px;">
          Nenhum certificado registrado. Adicione um comprovante acima para gerar sua nota no Obsidian!
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
              <i class="ph ph-file-pdf"></i> ${escapeHtml(cert.fileName)}
            </p>
          </div>

          <div class="cert-item__actions">
            <button type="button" class="btn btn--ghost" data-action="download-file" data-id="${cert.id}" title="Baixar PDF/Imagem">
              <i class="ph-bold ph-download-simple"></i>
              <span>Arquivo</span>
            </button>
            <button type="button" class="btn btn--obsidian" data-action="open-obsidian" data-id="${cert.id}" title="Enviar nota para o app Obsidian">
              <i class="ph-fill ph-notebook"></i>
              <span>Obsidian</span>
            </button>
            <button type="button" class="btn btn--icon" data-action="download-md" data-id="${cert.id}" title="Baixar nota .md">
              <i class="ph ph-markdown-logo"></i>
            </button>
            <button type="button" class="btn btn--icon" data-action="delete" data-id="${cert.id}" title="Excluir">
              <i class="ph ph-trash"></i>
            </button>
          </div>
        </article>
      `
      )
      .join("");
  }

  renderUI();

  // Vincular pasta física do Obsidian Vault (File System Access API)
  btnLinkObsidian.addEventListener("click", async () => {
    if (!("showDirectoryPicker" in window)) {
      alert("Seu navegador atual usa o botão 'Obsidian' em cada card (via protocolo obsidian://) ou download direto de .md.");
      return;
    }
    try {
      obsidianVaultHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      obsidianStatusText.textContent = `Vault: ${obsidianVaultHandle.name}`;
      // Sincroniza todos os certificados atuais na pasta escolhida
      for (const cert of certificates) {
        await syncCertificateToObsidianFolder(cert, profile, certificates);
      }
    } catch {
      // Usuário cancelou a janela de pasta
    }
  });

  certFileInput.addEventListener("change", () => {
    const file = certFileInput.files[0];
    dropzoneText.textContent = file
      ? `Selecionado: ${file.name}`
      : "Toque para selecionar ou arraste o certificado";
  });

  // Adicionar Certificado (Local + Obsidian Vault + Firestore Criptografado)
  certForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("cert-name").value.trim();
    const category = document.getElementById("cert-category").value;
    const hours = Number(document.getElementById("cert-hours").value);
    const file = certFileInput.files[0];

    if (!file || hours <= 0) return;

    const sha256 = await computeFileHash(file);
    const safeNoteName = `Horas_Complementares/${name.replace(/[\\/:*?"<>|]/g, "-")}.md`;

    const newCert = {
      id: crypto.randomUUID(),
      userId: profile.uid,
      name,
      category,
      hours,
      fileName: file.name,
      fileType: file.type || "application/octet-stream",
      fileBlob: file,
      sha256,
      obsidianNotePath: safeNoteName,
      createdAt: Date.now()
    };

    // 1. Salva no banco local IndexedDB
    await saveLocalCert(newCert);
    certificates = [newCert, ...certificates];
    renderUI();

    // 2. Se a pasta do Vault Obsidian estiver vinculada, grava o PDF e a nota .md lá dentro
    await syncCertificateToObsidianFolder(newCert, profile, certificates);

    // 3. Salva metadados criptografados (AES-GCM) no Firestore (sem usar Firebase Storage)
    if (isFirebaseReady) {
      try {
        const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
        const { fbDb } = await initFirebaseModules();
        const encrypted = await encryptPayload(profile.uid, {
          name: newCert.name,
          fileName: newCert.fileName
        });

        await setDoc(doc(fbDb, "users", profile.uid, "certificates", newCert.id), {
          cipherText: encrypted.cipherText,
          iv: encrypted.iv,
          hours: newCert.hours,
          category: newCert.category,
          sha256: newCert.sha256,
          obsidianNotePath: newCert.obsidianNotePath,
          createdAt: newCert.createdAt
        });
      } catch (err) {
        console.warn("Erro ao sincronizar metadado criptografado no Firestore:", err);
      }
    }

    certForm.reset();
    dropzoneText.textContent = "Toque para selecionar ou arraste o certificado";
  });

  // Ações nos Cards do Cofre (Baixar Arquivo, Abrir no Obsidian via URI, Baixar .md, Excluir)
  vaultGrid.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;

    const { action, id } = btn.dataset;
    const cert = certificates.find((c) => c.id === id);
    if (!cert) return;

    if (action === "download-file") {
      if (!cert.fileBlob) {
        alert("Este arquivo está salvo na pasta Anexos do seu Vault Obsidian.");
        return;
      }
      const url = URL.createObjectURL(cert.fileBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = cert.fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2500);
    }

    if (action === "download-md") {
      const mdContent = generateObsidianMarkdown(cert, profile);
      const blob = new Blob([mdContent], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${cert.name.replace(/[\\/:*?"<>|]/g, "-")}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2500);
    }

    if (action === "open-obsidian") {
      const mdContent = generateObsidianMarkdown(cert, profile);
      const vault = encodeURIComponent(profile.vaultName || "Faculdade");
      const file = encodeURIComponent(`Horas_Complementares/${cert.name.replace(/[\\/:*?"<>|]/g, "-")}`);
      const content = encodeURIComponent(mdContent);
      window.location.href = `obsidian://new?vault=${vault}&file=${file}&content=${content}`;
    }

    if (action === "delete") {
      await deleteLocalCert(id);
      certificates = certificates.filter((c) => c.id !== id);
      renderUI();

      if (isFirebaseReady) {
        try {
          const { doc, deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
          const { fbDb } = await initFirebaseModules();
          await deleteDoc(doc(fbDb, "users", profile.uid, "certificates", id));
        } catch (err) {
          console.warn("Erro ao remover do Firestore:", err);
        }
      }
    }
  });

  // Editar Cota / Curso / Nome do Vault
  btnOpenQuota.addEventListener("click", () => {
    document.getElementById("input-course").value = profile.course || "Administração - UFSJ";
    document.getElementById("input-vault").value = profile.vaultName || "Faculdade";
    document.getElementById("input-quota").value = profile.quota || 200;
    quotaModal.showModal();
  });

  btnCloseModal.addEventListener("click", () => quotaModal.close());

  quotaForm.addEventListener("submit", async () => {
    profile.course = document.getElementById("input-course").value.trim();
    profile.vaultName = document.getElementById("input-vault").value.trim();
    profile.quota = Number(document.getElementById("input-quota").value) || 200;
    localStorage.setItem("chronos_user", JSON.stringify(profile));
    renderUI();

    if (isFirebaseReady) {
      try {
        const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
        const { fbDb } = await initFirebaseModules();
        await setDoc(doc(fbDb, "users", profile.uid), {
          course: profile.course,
          vaultName: profile.vaultName,
          quota: profile.quota,
          updatedAt: Date.now()
        }, { merge: true });
      } catch (err) {
        console.warn("Erro ao atualizar cota no Firestore:", err);
      }
    }
  });

  searchInput.addEventListener("input", (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderUI();
  });

  btnLogout.addEventListener("click", () => {
    localStorage.removeItem("chronos_user");
    window.location.href = "login.html";
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}