import { useEffect, useState } from "react";
import type { BrandingAssets } from "./desktop-api";

export const companyName = "Nextway Logistics GmbH";

const images = import.meta.glob<string>("./branding/*.{png,jpg,jpeg,webp}", {
  eager: true,
  import: "default",
  query: "?url&no-inline",
});

function asset(stem: string) {
  return Object.entries(images).find(([name]) => name.split("/").at(-1)?.split(".")[0] === stem)?.[1];
}

const bundled: BrandingAssets = {
  container: asset("nextway-container"),
  logoLight: asset("nextway-logo-light"),
  logoDark: asset("nextway-logo-dark"),
};

let current: BrandingAssets = bundled;
let loading: Promise<BrandingAssets> | undefined;

function useBranding() {
  const [branding, setBranding] = useState(() => current);
  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop?.getBrandingAssets) return;
    let active = true;
    loading ??= desktop.getBrandingAssets()
      .then((local) => { current = { ...bundled, ...local }; return current; })
      .catch(() => bundled);
    void loading.then((assets) => { if (active) setBranding(assets); });
    return () => { active = false; };
  }, []);
  return branding;
}

export function CompanyBrand({ variant }: { variant: "sidebar" | "login" }) {
  const { logoDark, logoLight } = useBranding();
  const logo = variant === "sidebar" ? logoLight ?? logoDark : logoDark ?? logoLight;
  const needsInversion = variant === "sidebar" ? !logoLight && logoDark : !logoDark && logoLight;
  return <div className={`company-brand company-brand--${variant}`}>
    {logo
      ? <img className={`company-logo ${needsInversion ? "company-logo--invert" : ""}`} src={logo} alt={companyName}
          onLoad={({ currentTarget: image }) => {
            image.classList.toggle("company-logo--crop", image.naturalWidth < image.naturalHeight * 2);
          }} />
      : <span className="company-wordmark">Nextway</span>}
    <span className="company-app-name">Arbeitszeiterfassung</span>
  </div>;
}

export function BrandPhoto({ className }: { className: string }) {
  const { container } = useBranding();
  return container ? <img className={className} src={container} alt="" /> : null;
}

export function ProofBrand() {
  const { logoDark } = useBranding();
  return logoDark
    ? <img className="proof-brand" src={logoDark} alt={companyName} />
    : <span className="proof-brand">{companyName}</span>;
}
