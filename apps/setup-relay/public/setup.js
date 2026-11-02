// @ts-check
import {
  normalizeServerUrl,
  setupFragment,
  studioSetupUrl,
} from "./address.js";

const STORAGE_KEY = "tilecast.setup.server";

/** @type {Record<string, Record<string, string>>} */
const STRINGS = {
  en: {
    title: "Set up a Tilecast screen",
    lead: "Enter the address you use to open Tilecast Studio. Studio sends it to the screen, and you approve the screen there.",
    label: "Tilecast Studio address",
    submit: "Continue in Studio",
    privacy:
      "This page does not send your address anywhere. It stays on this phone.",
    missingTitle: "Scan the code on your screen",
    missingLead:
      "Open this page from the QR code that a Tilecast screen shows during setup. You can also type the server address on the screen with the remote.",
    empty: "Enter your Tilecast Studio address.",
    invalid: "That is not a valid address.",
    scheme: "The address must start with https:// or http://.",
    credentials: "Remove the user name and password from the address.",
    path: "Enter only the address, without a path such as /screens.",
    insecure:
      "A public address must use https://. Plain http:// works only on a local network.",
  },
  es: {
    title: "Configurar una pantalla Tilecast",
    lead: "Escribe la dirección que usas para abrir Tilecast Studio. Studio la envía a la pantalla y allí apruebas la pantalla.",
    label: "Dirección de Tilecast Studio",
    submit: "Continuar en Studio",
    privacy:
      "Esta página no envía tu dirección a ningún sitio. Se queda en este teléfono.",
    missingTitle: "Escanea el código de tu pantalla",
    missingLead:
      "Abre esta página desde el código QR que muestra una pantalla Tilecast durante la configuración. También puedes escribir la dirección del servidor en la pantalla con el mando.",
    empty: "Escribe la dirección de Tilecast Studio.",
    invalid: "La dirección no es válida.",
    scheme: "La dirección debe empezar por https:// o http://.",
    credentials: "Quita el usuario y la contraseña de la dirección.",
    path: "Escribe solo la dirección, sin una ruta como /screens.",
    insecure:
      "Una dirección pública debe usar https://. http:// solo funciona en una red local.",
  },
  ru: {
    title: "Настройка экрана Tilecast",
    lead: "Введите адрес, по которому вы открываете Tilecast Studio. Studio передаст его экрану, и там же вы подтвердите экран.",
    label: "Адрес Tilecast Studio",
    submit: "Продолжить в Studio",
    privacy:
      "Эта страница никуда не отправляет ваш адрес. Он остаётся на этом телефоне.",
    missingTitle: "Отсканируйте код на экране",
    missingLead:
      "Откройте эту страницу по QR-коду, который экран Tilecast показывает во время настройки. Адрес сервера также можно ввести на экране с пульта.",
    empty: "Введите адрес Tilecast Studio.",
    invalid: "Это недопустимый адрес.",
    scheme: "Адрес должен начинаться с https:// или http://.",
    credentials: "Удалите имя пользователя и пароль из адреса.",
    path: "Введите только адрес, без пути вроде /screens.",
    insecure:
      "Публичный адрес должен использовать https://. http:// работает только в локальной сети.",
  },
};

const language =
  navigator.languages
    .map((tag) => tag.slice(0, 2).toLowerCase())
    .find((tag) => tag in STRINGS) ?? "en";
const strings = /** @type {Record<string, string>} */ (STRINGS[language]);
document.documentElement.lang = language;
document.title = strings.title ?? "";
for (const element of document.querySelectorAll("[data-text]")) {
  element.textContent = strings[element.getAttribute("data-text") ?? ""] ?? "";
}

/** @param {string} key */
function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** @param {string} key @param {string} value */
function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private browsing. The address is only a convenience for the next screen.
  }
}

const fragment = setupFragment(location.hash);
const form = /** @type {HTMLFormElement} */ (document.getElementById("setup"));
const missing = /** @type {HTMLElement} */ (document.getElementById("missing"));
const input = /** @type {HTMLInputElement} */ (
  document.getElementById("server")
);
const message = /** @type {HTMLElement} */ (document.getElementById("error"));

if (fragment === null) {
  missing.hidden = false;
} else {
  form.hidden = false;
  /** @type {HTMLElement} */ (document.getElementById("privacy")).hidden =
    false;
  input.value = storageGet(STORAGE_KEY) ?? "";
  input.focus();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const result = normalizeServerUrl(input.value);
    if (!result.ok) {
      message.textContent = strings[result.error] ?? "";
      input.setAttribute("aria-invalid", "true");
      return;
    }
    storageSet(STORAGE_KEY, result.url);
    location.assign(studioSetupUrl(result.url, fragment));
  });
  input.addEventListener("input", () => {
    message.textContent = "";
    input.removeAttribute("aria-invalid");
  });
}
