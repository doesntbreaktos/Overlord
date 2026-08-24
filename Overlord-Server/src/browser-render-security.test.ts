import { describe, expect, test } from "bun:test";

const navTemplateUrl = new URL("../public/assets/nav/template.js", import.meta.url).href;
const { dropdownItem, sidebarChild } = await import(navTemplateUrl) as {
  dropdownItem: (child: Record<string, unknown>) => string;
  sidebarChild: (child: Record<string, unknown>) => string;
};

describe("backstage fake-client rendering", () => {
  test("does not concatenate lookup paths or window-map values into HTML", async () => {
    const source = await Bun.file(new URL("../public/assets/backstage.js", import.meta.url)).text();
    expect(source).not.toContain("+ msg.path");
    expect(source).not.toContain("windowMapCanvas.innerHTML = html");
    expect(source).not.toContain("windowMapList.innerHTML = listHtml");
    expect(source).toContain("normalizeWindowMapPayload");
    expect(source).toContain("document.createTextNode((killExe ?");
    expect(source).toContain("windowMapCanvas.replaceChildren(canvasFragment)");
    expect(source).toContain("windowMapList.replaceChildren(list)");
  });

  test("renders fake-client stream status labels as text", async () => {
    const source = await Bun.file(new URL("../public/assets/backstage.js", import.meta.url)).text();
    expect(source).not.toContain('statusEl.innerHTML = `${icons[state] || icons.idle} <span>${label}</span>`');
    expect(source).toContain('labelEl.textContent = String(label || "")');
  });
});

describe("remote media fake-client rendering", () => {
  test("renders remote desktop status and permission names as text", async () => {
    const source = await Bun.file(new URL("../public/assets/remotedesktop.js", import.meta.url)).text();
    expect(source).not.toContain('statusEl.innerHTML = `${icons[state] || icons.idle} <span>${label}</span>`');
    expect(source).not.toContain("<strong>macOS permissions missing:</strong> ${list}");
    expect(source).toContain('labelEl.textContent = String(label || "")');
    expect(source).toContain("missingEl.textContent = list");
  });

  test("renders webcam status reasons as text", async () => {
    const source = await Bun.file(new URL("../public/assets/webcam.js", import.meta.url)).text();
    expect(source).not.toContain('statusEl.innerHTML = `${icons[state] || icons.idle} <span>${label}</span>`');
    expect(source).toContain('labelEl.textContent = String(label || "")');
  });
});

describe("shared connection-status rendering", () => {
  test("keeps dynamic status labels out of HTML templates", async () => {
    const [consoleSource, processSource, voiceSource] = await Promise.all([
      Bun.file(new URL("../public/assets/console.js", import.meta.url)).text(),
      Bun.file(new URL("../public/assets/processes.js", import.meta.url)).text(),
      Bun.file(new URL("../public/assets/voice.js", import.meta.url)).text(),
    ]);

    expect(consoleSource).not.toContain("${label}");
    expect(consoleSource).toContain("document.createTextNode");
    expect(processSource).not.toContain("${text}");
    expect(processSource).toContain("document.createTextNode");
    expect(voiceSource).not.toContain("<span>${text}</span>");
    expect(voiceSource).toContain('label.textContent = String(text || "")');
  });
});

describe("settings and build API rendering", () => {
  test("keeps MFA SVG responses out of the document DOM and rejects executable links", async () => {
    const source = await Bun.file(new URL("../public/assets/settings.js", import.meta.url)).text();
    expect(source).not.toContain('mfaQrCode.innerHTML = data.qrSvg');
    expect(source).not.toContain('mfaOtpauthLink.href = data.otpauthUrl');
    expect(source).toContain("data:image/svg+xml;charset=utf-8");
    expect(source).toContain('parsed.protocol === "otpauth:" && parsed.hostname === "totp"');
  });

  test("escapes build eligibility errors and coerces response counts", async () => {
    const source = await Bun.file(new URL("../public/assets/build.js", import.meta.url)).text();
    expect(source).not.toContain('${data.error || "Failed to check eligible clients"}</p>');
    expect(source).not.toContain("Error: ${err.message}</p>");
    expect(source).toContain('escapeHtml(data.error || "Failed to check eligible clients")');
    expect(source).toContain("Math.trunc(Number(data.eligible) || 0)");
  });
});

describe("dynamic plugin navigation rendering", () => {
  const hostile = {
    href: "javascript:alert(1)",
    linkId: 'plugin\" autofocus onfocus=\"alert(1)',
    icon: 'fa-cube\" onmouseover=\"alert(1)',
    iconColor: "text-red-400 <img",
    label: '<img src=x onerror="alert(1)">',
  };

  test("escapes labels and rejects executable topbar attributes", () => {
    const html = dropdownItem(hostile);
    expect(html).toContain('href="#"');
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("javascript:alert");
    expect(html).not.toContain('onmouseover="');
  });

  test("escapes labels and rejects executable sidebar attributes", () => {
    const html = sidebarChild(hostile);
    expect(html).toContain('href="#"');
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("javascript:alert");
    expect(html).not.toContain('onfocus="');
  });
});
