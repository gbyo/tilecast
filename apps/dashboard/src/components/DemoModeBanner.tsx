import { FlaskConical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Shown on every Studio page of a Demo Mode installation, so a screenshot or
 * a visitor can never mistake sample data for a real fleet.
 */
export function DemoModeBanner() {
  const { t } = useTranslation();
  return (
    <Alert
      role="status"
      data-testid="demo-mode-banner"
      className="rounded-none border-x-0 border-t-0 py-2"
    >
      <FlaskConical aria-hidden="true" />
      <AlertTitle>{t("demo.title")}</AlertTitle>
      <AlertDescription>{t("demo.description")}</AlertDescription>
    </Alert>
  );
}
