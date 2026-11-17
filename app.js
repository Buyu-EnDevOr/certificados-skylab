/**
 * ============================================================================
 * 1. CONFIGURAÇÃO DO FIREBASE (PROJETO: certificados-8a23e)
 * ============================================================================
 */
const firebaseConfig = {
  apiKey: "AIzaSyDJqhH859FJcI7qS5JEP2l9lcFAXtspzIk",
  authDomain: "certificados-8a23e.firebaseapp.com",
  projectId: "certificados-8a23e",
  storageBucket: "certificados-8a23e.firebasestorage.app",
  messagingSenderId: "384791889838",
  appId: "1:384791889838:web:c37d9984f88789a94b6a3f"
};

const isFirebaseReady = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

/**
 * ============================================================================
 * 2. COMPRESSOR AUTOMÁTICO DE IMAGEM (SALVA DIRETO NO FIRESTORE SEM STORAGE)
 * ============================================================================
 */
async function compressFileToDataUrl(file) {
  if (file.type === "application/pdf") {
    if (file.size > 700 * 1024) {
      throw new Error("Para PDFs acima de 700KB, envie um print ou foto do certificado para compressão automática.");
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const MAX_WIDTH = 1400;
      const MAX_HEIGHT = 1400;
      let { width, height } = img;

      if (width > MAX_WIDTH || height > MAX_HEIGHT) {
        const ratio = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);

      const compressedDataUrl = canvas.toDataURL("image/jpeg", 0.78);
      resolve(compressedDataUrl);
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Não foi possível processar esta imagem."));
    };

    img.src = objectUrl;
  });
}

/**
 * ============================================================================
 * 3. CRIPTOGRAFIA CLIENT-SIDE (AES-GCM 256)
 * ============================================================================
 */
async function deriveUserKey(uid) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(uid + "_CHRONOS_KEY_2026"),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode("chronos-academic-salt"),
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptMeta(uid, plainObj) {
  const key = await deriveUserKey(uid);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(plainObj));
  const cipherBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  return {
    cipherMeta: btoa(String.fromCharCode(...new Uint8Array(cipherBuffer))),
    iv: btoa(String.fromCharCode(...iv))
  };
}

async function decryptMeta(uid, cipherMeta, ivBase64) {
  try {
    const key = await deriveUserKey(uid);
    const iv = Uint8Array.from(atob(ivBase64), (c) => c.charCodeAt(0));
    const cipherBytes = Uint8Array.from(atob(cipherMeta), (c) => c.charCodeAt(0));
    const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);
    return JSON.parse(new TextDecoder().decode(decryptedBuffer));
  } catch {
    return { name: "Certificado", fileName: "certificado.jpg" };
  }
}

/**
 * ============================================================================
 * 4. CACHE LOCAL INDEXEDDB
 * ============================================================================
 */
const DB_NAME = "ChronosZeroFrictionDB";
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
 * 5. GERADOR DE RELATÓRIO COMPLETO EM PDF (TABELA DE HORAS + FOTOS ANEXADAS)
 * ============================================================================
 */
async function generateCompletePdfReport(profile, certificates) {
  if (!window.jspdf) {
    alert("Biblioteca de PDF ainda carregando. Verifique sua conexão e tente novamente.");
    return;
  }

  if (certificates.length === 0) {
    alert("Adicione pelo menos um certificado antes de gerar o relatório em PDF.");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  const quota = Number(profile.quota) || 200;
  const totalDone = certificates.reduce((sum, c) => sum + Number(c.hours), 0);
  const remaining = Math.max(quota - totalDone, 0);
  const percent = quota > 0 ? Math.min(Math.round((totalDone / quota) * 100), 100) : 0;
  const emissionDate = new Date().toLocaleDateString("pt-BR");

  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, 210, 40, "F");

  doc.setTextColor(6, 182, 212);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("CHRONOS ACADÊMICO — DOSSIÊ DE INTEGRALIZAÇÃO CURRICULAR", 14, 14);

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.text("Relatório de Horas Complementares", 14, 24);

  doc.setTextColor(148, 163, 184);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(`Curso: ${profile.course || "Graduação"}  |  Estudante: ${profile.email}  |  Emissão: ${emissionDate}`, 14, 33);

  doc.setFillColor(241, 245, 249);
  doc.setDrawColor(203, 213, 225);
  doc.roundedRect(14, 48, 182, 24, 3, 3, "FD");

  doc.setTextColor(71, 85, 105);
  doc.setFontSize(9);
  doc.text("COTA EXIGIDA", 22, 56);
  doc.text("HORAS COMPUTADAS", 72, 56);
  doc.text("HORAS RESTANTES", 126, 56);
  doc.text("PROGRESSO", 170, 56);

  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text(`${quota}h`, 22, 65);
  doc.setTextColor(8, 145, 178);
  doc.text(`${totalDone}h`, 72, 65);
  doc.setTextColor(remaining === 0 ? 16 : 217, remaining === 0 ? 185 : 119, remaining === 0 ? 129 : 6);
  doc.text(`${remaining}h`, 126, 65);
  doc.setTextColor(15, 23, 42);
  doc.text(`${percent}%`, 170, 65);

  let y = 84;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.text("1. Quadro Detalhado de Atividades e Certificados", 14, y);
  y += 6;

  doc.setFillColor(30, 41, 59);
  doc.rect(14, y, 182, 8, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9);
  doc.text("Nº", 18, y + 5.5);
  doc.text("ATIVIDADE / EVENTO", 32, y + 5.5);
  doc.text("CATEGORIA", 132, y + 5.5);
  doc.text("DATA", 162, y + 5.5);
  doc.text("HORAS", 182, y + 5.5);
  y += 8;

  doc.setFont("helvetica", "normal");
  certificates.forEach((cert, index) => {
    if (y > 265) {
      doc.addPage();
      y = 20;
    }

    if (index % 2 === 0) {
      doc.setFillColor(248, 250, 252);
      doc.rect(14, y, 182, 8, "F");
    }

    const numStr = String(index + 1).padStart(2, "0");
    const titleStr = cert.name.length > 52 ? cert.name.slice(0, 49) + "..." : cert.name;
    const dateStr = new Date(cert.createdAt).toLocaleDateString("pt-BR");

    doc.setTextColor(15, 23, 42);
    doc.text(`#${numStr}`, 18, y + 5.5);
    doc.text(titleStr, 32, y + 5.5);
    doc.text(String(cert.category), 132, y + 5.5);
    doc.text(dateStr, 162, y + 5.5);

    doc.setFont("helvetica", "bold");
    doc.text(`${cert.hours}h`, 183, y + 5.5);
    doc.setFont("helvetica", "normal");

    y += 8;
  });

  doc.setFillColor(226, 232, 240);
  doc.rect(14, y, 182, 9, "F");
  doc.setFont("helvetica", "bold");
  doc.setTextColor(15, 23, 42);
  doc.text("TOTAL GERAL COMPUTADO", 18, y + 6);
  doc.text(`${totalDone}h / ${quota}h`, 175, y + 6);

  for (let i = 0; i < certificates.length; i++) {
    const cert = certificates[i];
    if (!cert.fileData || !cert.fileData.startsWith("data:image")) continue;

    doc.addPage();

    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, 210, 26, "F");

    doc.setTextColor(6, 182, 212);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(`COMPROVANTE ANEXO #${String(i + 1).padStart(2, "0")}`, 14, 10);

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(13);
    const cleanTitle = cert.name.length > 65 ? cert.name.slice(0, 62) + "..." : cert.name;
    doc.text(cleanTitle, 14, 19);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(71, 85, 105);
    doc.text(`Categoria: ${cert.category}   |   Carga Horária Validada: +${cert.hours} horas`, 14, 35);

    try {
      const dims = await getImageDimensions(cert.fileData);
      const maxW = 182;
      const maxH = 230;
      const ratio = Math.min(maxW / dims.width, maxH / dims.height);
      const renderW = dims.width * ratio;
      const renderH = dims.height * ratio;
      const offsetX = 14 + (maxW - renderW) / 2;

      doc.setDrawColor(203, 213, 225);
      doc.rect(offsetX - 1, 41, renderW + 2, renderH + 2);
      doc.addImage(cert.fileData, "JPEG", offsetX, 42, renderW, renderH);
    } catch {
      doc.text("Imagem anexada em formato incompatível para pré-visualização.", 14, 50);
    }
  }

  const safeCourse = (profile.course || "Faculdade").replace(/[^a-zA-Z0-9_-]/g, "_");
  doc.save(`Relatorio_Horas_Complementares_${safeCourse}.pdf`);
}

function getImageDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * ============================================================================
 * 6. FIREBASE AUTH + FIRESTORE
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
    course: registrationMeta?.course || "Graduação",
    quota: Number(registrationMeta?.quota || 200),
    termsAccepted: false,
    updatedAt: Date.now()
  };

  if (snap.exists() && !registrationMeta) {
    profile = { ...profile, ...snap.data() };
  } else {
    await setDoc(userRef, {
      course: profile.course,
      quota: profile.quota,
      termsAccepted: Boolean(profile.termsAccepted),
      updatedAt: Date.now()
    }, { merge: true });
  }

  localStorage.setItem("chronos_user", JSON.stringify(profile));
  window.location.href = "index.html";
}

/**
 * ============================================================================
 * 7. ROTEAMENTO DE PÁGINAS
 * ============================================================================
 */
const currentPage = document.body.dataset.page;

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
    const quota = Number(document.getElementById("reg-quota").value);

    try {
      alertBox.hidden = true;
      await authenticateWithGoogle({ course, quota });
    } catch (err) {
      alertBox.hidden = false;
      alertBox.textContent = `Erro ao cadastrar (${err.code || "Auth"}): verifique os domínios autorizados no Firebase.`;
    }
  });
}

if (currentPage === "dashboard") {
  initDashboard();
  // Modal de Relatar Bugs ou Enviar Dicas
  const feedbackModal = document.getElementById("feedback-modal");
  const feedbackForm = document.getElementById("feedback-form");
  const btnOpenFeedback = document.getElementById("btn-open-feedback");
  const btnCloseFeedback = document.getElementById("btn-close-feedback");
  const btnSubmitFeedback = document.getElementById("btn-submit-feedback");
  const btnFeedbackText = document.getElementById("btn-feedback-text");
  const feedbackStatus = document.getElementById("feedback-status");

  if (btnOpenFeedback && feedbackModal) {
    btnOpenFeedback.addEventListener("click", () => {
      feedbackStatus.hidden = true;
      feedbackModal.showModal();
    });

    btnCloseFeedback.addEventListener("click", () => {
      feedbackModal.close();
    });

    feedbackForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const typeInput = feedbackForm.querySelector('input[name="feedback-type"]:checked');
      const type = typeInput ? typeInput.value : "dica";
      const area = document.getElementById("feedback-area").value;
      const message = document.getElementById("feedback-message").value.trim();

      if (!message) return;

      try {
        btnSubmitFeedback.disabled = true;
        btnFeedbackText.textContent = "Enviando...";

        const { collection, addDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
        const { fbDb } = await initFirebaseModules();

        await addDoc(collection(fbDb, "feedbacks"), {
          uid: profile.uid,
          email: profile.email || "anônimo",
          course: profile.course || "Não informado",
          type,
          area,
          message,
          userAgent: navigator.userAgent,
          createdAt: Date.now()
        });

        feedbackStatus.textContent = "Valeu! Seu relato foi enviado com sucesso.";
        feedbackStatus.hidden = false;
        feedbackForm.reset();

        setTimeout(() => {
          feedbackModal.close();
          feedbackStatus.hidden = true;
        }, 1400);
      } catch (err) {
        alert("Não foi possível enviar agora. Verifique se publicou as novas regras do Firestore.");
        console.error("Erro ao salvar feedback:", err);
      } finally {
        btnSubmitFeedback.disabled = false;
        btnFeedbackText.textContent = "Enviar Mensagem";
      }
    });
  }
}
// ==========================================================================
  // PAINEL SECRETO DO ADMINISTRADOR (EXCLUSIVO: pedroeliasm08@gmail.com)
  // ==========================================================================
  const ADMIN_EMAIL = "pedroeliasm08@gmail.com";
  const btnAdminPanel = document.getElementById("btn-admin-panel");
  const adminBadgeCount = document.getElementById("admin-badge-count");
  const adminModal = document.getElementById("admin-modal");
  const btnCloseAdmin = document.getElementById("btn-close-admin");
  const adminFeedbackList = document.getElementById("admin-feedback-list");

  let allFeedbacks = [];

  if (profile.email && profile.email.toLowerCase() === ADMIN_EMAIL && btnAdminPanel) {
    btnAdminPanel.hidden = false;

    async function loadAdminFeedbacks() {
      try {
        const { collection, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
        const { fbDb } = await initFirebaseModules();
        const snap = await getDocs(collection(fbDb, "feedbacks"));

        allFeedbacks = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => b.createdAt - a.createdAt);

        const pendingCount = allFeedbacks.filter((f) => f.status !== "respondido").length;
        adminBadgeCount.textContent = String(pendingCount);
        renderAdminTickets();
      } catch (err) {
        console.warn("Erro ao carregar relatos do admin:", err);
      }
    }

    function renderAdminTickets() {
      if (allFeedbacks.length === 0) {
        adminFeedbackList.innerHTML = `
          <div class="text-dim" style="text-align: center; padding: 32px;">
            Nenhum bug ou dica enviado pelos alunos até o momento.
          </div>
        `;
        return;
      }

      adminFeedbackList.innerHTML = allFeedbacks
        .map((item) => {
          const isBug = item.type === "bug";
          const isReplied = item.status === "respondido";
          const dateStr = new Date(item.createdAt).toLocaleString("pt-BR");

          return `
            <article class="admin-ticket ${isReplied ? "admin-ticket--replied" : ""}" data-ticket-id="${item.id}">
              <div class="admin-ticket__header">
                <div class="cluster">
                  <span class="badge ${isBug ? "badge--bug" : ""}">
                    ${isBug ? "BUG" : "DICA"} • ${escapeHtml(item.area || "Geral")}
                  </span>
                  <strong style="font-size: 13px;">${escapeHtml(item.email)}</strong>
                  <span class="text-dim">(${escapeHtml(item.course || "Curso não informado")})</span>
                </div>
                <div class="cluster">
                  <span class="mono-tag">${dateStr}</span>
                  ${isReplied ? '<span class="badge badge--done">Respondido</span>' : ""}
                </div>
              </div>

              <div class="admin-ticket__msg">${escapeHtml(item.message)}</div>

              <div class="admin-reply-area">
                <label class="field__label">Sua resposta para ${escapeHtml(item.email)}:</label>
                <textarea
                  class="field__input field__textarea"
                  rows="2"
                  id="reply-text-${item.id}"
                  placeholder="Digite sua resposta aqui para enviar direto ao e-mail do aluno..."
                >${escapeHtml(item.adminReply || "")}</textarea>

                <div class="cluster" style="justify-content: flex-end; margin-top: 4px;">
                  <button type="button" class="btn btn--ghost" data-admin-action="mailto" data-id="${item.id}" title="Abrir app de e-mail padrão">
                    <i class="ph ph-envelope-simple"></i>
                    <span>App de E-mail</span>
                  </button>
                  <button type="button" class="btn btn--primary" data-admin-action="gmail" data-id="${item.id}">
                    <i class="ph-bold ph-paper-plane-tilt"></i>
                    <span>Enviar pelo Gmail & Marcar Respondido</span>
                  </button>
                  <button type="button" class="btn btn--icon" data-admin-action="delete-ticket" data-id="${item.id}" title="Excluir relato">
                    <i class="ph ph-trash"></i>
                  </button>
                </div>
              </div>
            </article>
          `;
        })
        .join("");
    }

    // Carrega o contador assim que você entra no painel
    loadAdminFeedbacks();

    btnAdminPanel.addEventListener("click", async () => {
      await loadAdminFeedbacks();
      adminModal.showModal();
    });

    btnCloseAdmin.addEventListener("click", () => adminModal.close());

    adminFeedbackList.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-admin-action]");
      if (!btn) return;

      const { adminAction, id } = btn.dataset;
      const ticket = allFeedbacks.find((t) => t.id === id);
      if (!ticket) return;

      if (adminAction === "gmail" || adminAction === "mailto") {
        const replyInput = document.getElementById(`reply-text-${id}`);
        const replyText = replyInput ? replyInput.value.trim() : "";

        if (!replyText) {
          alert("Digite uma resposta no campo de texto antes de enviar o e-mail.");
          return;
        }

        const subject = encodeURIComponent(
          `[Chronos Acadêmico] Resposta sobre seu relato (${ticket.area || ticket.type.toUpperCase()})`
        );
        const body = encodeURIComponent(
          `Olá!\n\nRecebemos a sua mensagem enviada no Chronos Acadêmico:\n"${ticket.message}"\n\n` +
          `--- Resposta da Equipe Chronos ---\n${replyText}\n\n` +
          `Atenciosamente,\nPedro Elias — Chronos Acadêmico\nhttps://certificados-skylab.vercel.app/`
        );

        // Abre o Gmail Web com tudo preenchido ou o cliente de e-mail nativo
        if (adminAction === "gmail") {
          const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(ticket.email)}&su=${subject}&body=${body}`;
          window.open(gmailUrl, "_blank", "noopener,noreferrer");
        } else {
          window.location.href = `mailto:${encodeURIComponent(ticket.email)}?subject=${subject}&body=${body}`;
        }

        // Salva a resposta e marca como "respondido" no Firestore
        try {
          const { doc, updateDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
          const { fbDb } = await initFirebaseModules();
          await updateDoc(doc(fbDb, "feedbacks", id), {
            status: "respondido",
            adminReply: replyText,
            repliedAt: Date.now()
          });
          ticket.status = "respondido";
          ticket.adminReply = replyText;
          const pendingCount = allFeedbacks.filter((f) => f.status !== "respondido").length;
          adminBadgeCount.textContent = String(pendingCount);
          renderAdminTickets();
        } catch (err) {
          console.warn("Erro ao atualizar status do ticket:", err);
        }
      }

      if (adminAction === "delete-ticket") {
        try {
          const { doc, deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
          const { fbDb } = await initFirebaseModules();
          await deleteDoc(doc(fbDb, "feedbacks", id));
          allFeedbacks = allFeedbacks.filter((t) => t.id !== id);
          const pendingCount = allFeedbacks.filter((f) => f.status !== "respondido").length;
          adminBadgeCount.textContent = String(pendingCount);
          renderAdminTickets();
        } catch (err) {
          console.warn("Erro ao excluir ticket:", err);
        }
      }
    });
  }
/**
 * ============================================================================
 * 8. PAINEL PRINCIPAL (DASHBOARD + MODAL DE TERMOS PÓS-LOGIN)
 * ============================================================================
 */
async function initDashboard() {
  const profile = JSON.parse(localStorage.getItem("chronos_user") || "null");
  if (!profile) {
    window.location.href = "login.html";
    return;
  }

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
  const btnSubmitText = document.getElementById("btn-submit-text");
  const btnExportPdf = document.getElementById("btn-export-pdf");

  const quotaModal = document.getElementById("quota-modal");
  const quotaForm = document.getElementById("quota-form");
  const btnOpenQuota = document.getElementById("btn-open-quota");
  const btnCloseModal = document.getElementById("btn-close-modal");
  const btnLogout = document.getElementById("btn-logout");

  const previewModal = document.getElementById("preview-modal");
  const previewTitle = document.getElementById("preview-title");
  const previewBody = document.getElementById("preview-body");
  const btnClosePreview = document.getElementById("btn-close-preview");

  // Modal de Termos de Uso e Privacidade Pós-Login
  const legalModal = document.getElementById("legal-modal");
  const chkAcceptTerms = document.getElementById("chk-accept-terms");
  const btnAcceptTerms = document.getElementById("btn-accept-terms");

  const termsKey = `chronos_terms_accepted_${profile.uid}`;
  const hasAcceptedTerms = Boolean(profile.termsAccepted || localStorage.getItem(termsKey) === "true");

  if (!hasAcceptedTerms && legalModal) {
    // Impede fechar com a tecla ESC sem aceitar
    legalModal.addEventListener("cancel", (e) => e.preventDefault());
    legalModal.showModal();

    chkAcceptTerms.addEventListener("change", () => {
      btnAcceptTerms.disabled = !chkAcceptTerms.checked;
    });

    btnAcceptTerms.addEventListener("click", async () => {
      if (!chkAcceptTerms.checked) return;

      profile.termsAccepted = true;
      profile.termsAcceptedAt = Date.now();
      localStorage.setItem(termsKey, "true");
      localStorage.setItem("chronos_user", JSON.stringify(profile));
      legalModal.close();

      try {
        const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
        const { fbDb } = await initFirebaseModules();
        await setDoc(doc(fbDb, "users", profile.uid), {
          course: profile.course || "Graduação",
          quota: Number(profile.quota) || 200,
          termsAccepted: true,
          termsAcceptedAt: profile.termsAcceptedAt,
          updatedAt: Date.now()
        }, { merge: true });
      } catch (err) {
        console.warn("Erro ao registrar aceite no Firestore:", err);
      }
    });
  }

  const CIRCUMFERENCE = 2 * Math.PI * 92;
  let certificates = await getLocalCerts(profile.uid);
  let searchQuery = "";

  try {
    const { collection, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const { fbDb } = await initFirebaseModules();
    const snap = await getDocs(collection(fbDb, "users", profile.uid, "certificates"));
    const localIds = new Set(certificates.map((c) => c.id));

    for (const docSnap of snap.docs) {
      if (!localIds.has(docSnap.id)) {
        const data = docSnap.data();
        const decrypted = await decryptMeta(profile.uid, data.cipherMeta, data.iv);
        const syncedCert = {
          id: docSnap.id,
          userId: profile.uid,
          name: decrypted.name,
          fileName: decrypted.fileName,
          category: data.category,
          hours: data.hours,
          fileData: data.fileData,
          createdAt: data.createdAt
        };
        await saveLocalCert(syncedCert);
        certificates.push(syncedCert);
      }
    }
    certificates.sort((a, b) => b.createdAt - a.createdAt);
  } catch (e) {
    console.warn("Usando cache local:", e);
  }

  function renderUI() {
    courseTitle.textContent = profile.course || "Chronos Acadêmico";
    emailSubtitle.textContent = profile.email;

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
        c.category.toLowerCase().includes(searchQuery)
    );

    if (filtered.length === 0) {
      vaultGrid.innerHTML = `
        <div class="text-dim" style="grid-column: 1 / -1; text-align: center; padding: 32px;">
          Nenhum certificado salvo ainda. Envie a foto do seu primeiro certificado acima!
        </div>
      `;
      return;
    }

    vaultGrid.innerHTML = filtered
      .map((cert) => {
        const isImage = cert.fileData && cert.fileData.startsWith("data:image");
        const thumbHtml = isImage
          ? `<img src="${cert.fileData}" alt="${escapeHtml(cert.name)}" class="cert-thumb" data-action="preview" data-id="${cert.id}" />`
          : `<div class="cert-thumb centered text-dim" data-action="preview" data-id="${cert.id}"><i class="ph ph-file-pdf" style="font-size: 42px;"></i></div>`;

        return `
        <article class="cert-item" role="listitem">
          <div>
            ${thumbHtml}
            <div class="cert-item__meta" style="margin-top: 12px;">
              <span class="badge">${escapeHtml(cert.category)}</span>
              <strong class="mono-text text-cyan">+${Number(cert.hours)}h</strong>
            </div>
            <h4 class="cert-item__title">${escapeHtml(cert.name)}</h4>
          </div>

          <div class="cert-item__actions">
            <button type="button" class="btn btn--ghost" style="flex: 1;" data-action="preview" data-id="${cert.id}">
              <i class="ph ph-eye"></i>
              <span>Ver</span>
            </button>
            <button type="button" class="btn btn--ghost" style="flex: 1;" data-action="download" data-id="${cert.id}">
              <i class="ph-bold ph-download-simple"></i>
              <span>Baixar</span>
            </button>
            <button type="button" class="btn btn--icon" data-action="delete" data-id="${cert.id}" title="Excluir">
              <i class="ph ph-trash"></i>
            </button>
          </div>
        </article>
      `;
      })
      .join("");
  }

  renderUI();

  btnExportPdf.addEventListener("click", async () => {
    const span = btnExportPdf.querySelector("span");
    const originalText = span.textContent;
    try {
      span.textContent = "Gerando PDF...";
      await generateCompletePdfReport(profile, certificates);
    } finally {
      span.textContent = originalText;
    }
  });

  certFileInput.addEventListener("change", () => {
    const file = certFileInput.files[0];
    dropzoneText.textContent = file
      ? `Imagem pronta: ${file.name}`
      : "Toque para enviar a imagem do certificado";
  });

  certForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("cert-name").value.trim();
    const category = document.getElementById("cert-category").value;
    const hours = Number(document.getElementById("cert-hours").value);
    const file = certFileInput.files[0];

    if (!file || hours <= 0) return;

    try {
      btnSubmitText.textContent = "Otimizando e salvando...";
      const compressedDataUrl = await compressFileToDataUrl(file);
      const cleanFileName = file.type.startsWith("image/")
        ? file.name.replace(/\.[^.]+$/, "") + ".jpg"
        : file.name;

      const newCert = {
        id: crypto.randomUUID(),
        userId: profile.uid,
        name,
        category,
        hours,
        fileName: cleanFileName,
        fileData: compressedDataUrl,
        createdAt: Date.now()
      };

      await saveLocalCert(newCert);
      certificates = [newCert, ...certificates];
      renderUI();

      const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
      const { fbDb } = await initFirebaseModules();
      const encrypted = await encryptMeta(profile.uid, {
        name: newCert.name,
        fileName: newCert.fileName
      });

      await setDoc(doc(fbDb, "users", profile.uid, "certificates", newCert.id), {
        cipherMeta: encrypted.cipherMeta,
        iv: encrypted.iv,
        fileData: newCert.fileData,
        hours: newCert.hours,
        category: newCert.category,
        createdAt: newCert.createdAt
      });

      certForm.reset();
      dropzoneText.textContent = "Toque para enviar a imagem do certificado";
    } catch (err) {
      alert(err.message || "Erro ao processar a imagem.");
    } finally {
      btnSubmitText.textContent = "Salvar Certificado & Somar Horas";
    }
  });

  vaultGrid.addEventListener("click", async (e) => {
    const trigger = e.target.closest("[data-action]");
    if (!trigger) return;

    const { action, id } = trigger.dataset;
    const cert = certificates.find((c) => c.id === id);
    if (!cert) return;

    if (action === "preview") {
      previewTitle.textContent = `${cert.name} (+${cert.hours}h)`;
      if (cert.fileData.startsWith("data:image")) {
        previewBody.innerHTML = `<img src="${cert.fileData}" alt="${escapeHtml(cert.name)}" />`;
      } else {
        previewBody.innerHTML = `<iframe src="${cert.fileData}" width="100%" height="500px" style="border:none;"></iframe>`;
      }
      previewModal.showModal();
    }

    if (action === "download") {
      const a = document.createElement("a");
      a.href = cert.fileData;
      a.download = cert.fileName || `${cert.name}.jpg`;
      a.click();
    }

    if (action === "delete") {
      await deleteLocalCert(id);
      certificates = certificates.filter((c) => c.id !== id);
      renderUI();

      try {
        const { doc, deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
        const { fbDb } = await initFirebaseModules();
        await deleteDoc(doc(fbDb, "users", profile.uid, "certificates", id));
      } catch (err) {
        console.warn("Erro ao excluir do Firestore:", err);
      }
    }
  });

  btnClosePreview.addEventListener("click", () => previewModal.close());

  btnOpenQuota.addEventListener("click", () => {
    document.getElementById("input-course").value = profile.course || "Administração - UFSJ";
    document.getElementById("input-quota").value = profile.quota || 200;
    quotaModal.showModal();
  });

  btnCloseModal.addEventListener("click", () => quotaModal.close());

  quotaForm.addEventListener("submit", async () => {
    profile.course = document.getElementById("input-course").value.trim();
    profile.quota = Number(document.getElementById("input-quota").value) || 200;
    localStorage.setItem("chronos_user", JSON.stringify(profile));
    renderUI();

    try {
      const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
      const { fbDb } = await initFirebaseModules();
      await setDoc(doc(fbDb, "users", profile.uid), {
        course: profile.course,
        quota: profile.quota,
        updatedAt: Date.now()
      }, { merge: true });
    } catch (err) {
      console.warn("Erro ao atualizar cota:", err);
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