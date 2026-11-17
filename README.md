# 🎓 Chronos Acadêmico — Repositório de Horas Complementares

> **Acesse a aplicação online:** [https://certificados-skylab.vercel.app/](https://certificados-skylab.vercel.app/)

O **Chronos Acadêmico** (`certificados-skylab`) é uma aplicação web progressiva e *mobile-first* desenvolvida para resolver uma das maiores dores dos estudantes universitários: **guardar certificados ao longo da graduação e saber exatamente quantas horas faltam para atingir a cota exigida pela faculdade**.

---

## 💡 O Problema vs. A Solução

* **A Dor:** Durante os semestres, estudantes participam de palestras, semanas acadêmicas, cursos e monitorias, mas acabam espalhando os certificados no WhatsApp, e-mail ou pastas antigas do celular. Perto da formatura, ninguém sabe quantas horas já somou, quantas ainda faltam e onde estão os arquivos.
* **A Solução:** Uma plataforma gratuita com login via Conta Google onde o aluno define a cota exigida pelo seu curso, envia a foto ou print de cada certificado, acompanha o progresso em um gráfico circular em tempo real, baixa os arquivos de qualquer dispositivo e exporta um **Dossiê Completo em PDF (padrão A4)** com tabela somada e imagens anexadas para entregar na secretaria.

---

## ✨ Funcionalidades Principais

* **🔐 Login Rápido com Google (OAuth 2.0):** Autenticação integrada via Firebase Auth, permitindo acessar os certificados tanto pelo celular quanto pelo computador.
* **📊 Gráfico Circular Reativo em SVG:** Atualização instantânea da porcentagem concluída, horas computadas e horas restantes assim que um certificado é adicionado, editado ou removido.
* **🗜️ Compressor Inteligente de Imagens (Zero-Storage):** Fotos grandes tiradas pelo celular (5 MB a 10 MB) são otimizadas automaticamente no navegador via `Canvas API` (~120 KB) mantendo nitidez de leitura e permitindo armazenamento direto no Firestore sem custos de bucket externo.
* **🛡️ Criptografia Client-Side (AES-GCM 256-bit):** Os metadados dos certificados são criptografados no próprio navegador utilizando a `Web Crypto API` (`PBKDF2` + `AES-GCM`) antes de irem para a nuvem, combinados com cache local ultrarrápido via `IndexedDB`.
* **📄 Exportação de Relatório Oficial em PDF (A4):** Gera com 1 clique um documento A4 via `jsPDF` contendo cabeçalho institucional, resumo da meta, tabela numerada de atividades e páginas de anexo com a imagem de cada certificado centralizada.
* **✏️ Gestão Completa do Cofre:** Visualização em tela cheia, edição de título/categoria/horas/imagem, busca em tempo real e download individual de comprovantes.
* **💬 Aba Exclusiva de FAQ & Suporte + Painel Admin:** Central de dúvidas frequentes integrada com envio de relatos de bugs/sugestões e painel exclusivo do administrador para responder diretamente ao e-mail do estudante via Gmail ou cliente nativo.
* **⚖️ Conformidade Legal Pós-Login:** Modal de aceite obrigatório dos Termos de Uso e Política de Privacidade registrado no perfil do usuário.

---

## 🛠️ Tecnologias e Arquitetura

* **HTML5 Semântico:** Uso de elementos nativos modernos como `<dialog>` para modais acessíveis e `<details>` / `<summary>` para acordeões sem sobrecarga de script.
* **CSS3 Moderno (Zero Framework):**
  * Controle de especificidade estruturado com Cascade Layers (`@layer reset, base, tokens, components, patterns, utilities, overrides`).
  * Seletores relacionais `:has()` para formulários e cartões interativos.
  * Tipografia fluida com `clamp()`, CSS Nesting nativo e estética *Dark Glassmorphism*.
* **JavaScript (ES Modules):**
  * Persistência híbrida **Offline-First** (`IndexedDB` + `Firebase Firestore`).
  * Criptografia nativa com `window.crypto.subtle`.
  * Geração vetorial de documentos com `jsPDF`.
* **Hospedagem & BaaS:** Deploy contínuo na **Vercel** e backend serverless no **Google Firebase**.

---

## 📂 Estrutura de Arquivos

```text
├── index.html              # Painel principal, gráfico, cofre, aba de FAQ/Suporte e modais
├── login.html              # Tela de autenticação com Conta Google
├── cadastro.html           # Tela de criação de conta e definição inicial de curso/cota
├── termo-privacidade.html  # Política de Privacidade completa
├── termo-uso.html          # Termos e Condições de Uso da plataforma
├── faq.html                # Página dedicada de Perguntas Frequentes
├── style.css               # Arquitetura CSS em @layer com tokens e glassmorphism
└── app.js                  # Lógica de estado, criptografia AES-GCM, IndexedDB, PDF e Firebase
```

---

## 🚀 Como Rodar Localmente (VS Code)

1. Clone este repositório ou abra a pasta do projeto no **VS Code**.
2. Instale a extensão **Live Server**.
3. Clique com o botão direito no arquivo `login.html` ou `index.html` e selecione **"Open with Live Server"**.
4. No Console do Firebase (**Authentication > Configurações > Domínios autorizados**), certifique-se de que os seguintes domínios estejam cadastrados:
   * `localhost`
   * `127.0.0.1`
   * `certificados-skylab.vercel.app`

---

## 🔒 Regras de Segurança do Firestore (`firestore.rules`)

Para configurar o banco de dados no console do Firebase (**Firestore Database > Regras**), utilize as regras definitivas abaixo:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isOwner(userId) {
      return request.auth != null && request.auth.uid == userId;
    }

    match /users/{userId} {
      allow read, delete: if isOwner(userId);
      
      allow create, update: if isOwner(userId)
        && request.resource.data.keys().hasAll(['quota', 'updatedAt'])
        && request.resource.data.quota is number
        && request.resource.data.quota >= 10
        && request.resource.data.quota <= 5000;

      match /certificates/{certId} {
        allow read, delete: if isOwner(userId);

        allow create, update: if isOwner(userId)
          && request.resource.data.keys().hasAll([
            'cipherMeta',
            'iv',
            'fileData',
            'hours',
            'category',
            'createdAt'
          ])
          && request.resource.data.cipherMeta is string
          && request.resource.data.fileData is string
          && request.resource.data.hours is number
          && request.resource.data.hours > 0
          && request.resource.data.hours <= 1000;
      }
    }

    match /feedbacks/{feedbackId} {
      allow create: if request.auth != null
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.type in ['bug', 'dica']
        && request.resource.data.message is string
        && request.resource.data.message.size() >= 3
        && request.resource.data.message.size() <= 2000;

      allow read: if request.auth != null 
        && (request.auth.uid == resource.data.uid || request.auth.token.email == 'pedroeliasm08@gmail.com');

      allow update, delete: if request.auth != null 
        && request.auth.token.email == 'pedroeliasm08@gmail.com';
    }
  }
}
```

---

## 📬 Autor e Contato

Desenvolvido por **Pedro Elias Ferreira Maia**.  
Dúvidas, sugestões ou parcerias: [pedroeliasm08@gmail.com](mailto:pedroeliasm08@gmail.com)