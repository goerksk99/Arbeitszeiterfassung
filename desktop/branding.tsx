import { useEffect, useState, type SyntheticEvent } from "react";
import background from "../Background.png?url&no-inline";
import logo from "../Logo.png?url&no-inline";
import type { BrandingAssets } from "./desktop-api";

export const companyName = "Nextway Logistics GmbH";

const bundled: BrandingAssets = {
  container: background,
  logoDark: logo,
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

function cropLogo({ currentTarget: image }: SyntheticEvent<HTMLImageElement>) {
  image.classList.toggle("company-logo--crop", image.naturalWidth < image.naturalHeight * 2);
}

export function CompanyBrand({ variant }: { variant: "sidebar" | "login" }) {
  const { logoDark, logoLight } = useBranding();
  const logo = variant === "sidebar" ? logoLight ?? logoDark : logoDark ?? logoLight;
  const needsInversion = variant === "sidebar" ? !logoLight && logoDark : !logoDark && logoLight;
  return <div className={`company-brand company-brand--${variant}`}>
    {logo
      ? <img className={`company-logo ${needsInversion ? "company-logo--invert" : ""}`} src={logo} alt={companyName}
          onLoad={cropLogo} />
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
    ? <img className="proof-brand" src={logoDark} alt={companyName} onLoad={cropLogo} />
    : <span className="proof-brand">{companyName}</span>;
}
