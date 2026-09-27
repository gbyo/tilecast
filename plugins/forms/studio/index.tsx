import { ClipboardCheck, ClipboardList } from "lucide-react";
import {
  defineStudioPlugin,
  type BreadcrumbResourceLoader,
} from "@tilecast/studio";
import "./forms.css";
import { formsApi } from "./api";
import { canReviewForm } from "./forms/capabilities";
import type { FormSummary } from "./types";
import { ApprovalsPage } from "./ApprovalsPage";
import { CreateFormDataSourcePage } from "./CreateFormDataSourcePage";
import { FormsPluginPage } from "./FormsPluginPage";
import { FormDataSourcePage } from "./FormDataSourcePage";
import {
  FormPortalDetailPage,
  FormPortalSubmissionPage,
  FormsListPage,
  FormsPortalShell,
} from "./FormsPortalPage";

// The breadcrumb loader names a form's `:id` route. Its query key is shared
// with FormDataSourcePage, so the cached value must stay the full entity.
const formResource: BreadcrumbResourceLoader = {
  queryKey: (id: string) => ["form-data-source", id] as const,
  load: (id: string) => formsApi.getForm(id),
};

export default defineStudioPlugin({
  id: "forms",
  icon: ClipboardList,
  // The reviewer inbox in the Studio secondary navigation. Visibility is
  // Forms-owned: the inbox appears only when the viewer may act on some
  // form's responses queue. The generic shell never interprets Forms
  // capabilities; it only renders this contribution.
  secondaryNavigation: [
    {
      id: "approvals",
      to: "/approvals",
      icon: ClipboardCheck,
      labelKey: "nav.approvals",
      visibility: {
        queryKey: ["forms"],
        queryFn: () => formsApi.listForms(),
        visible: (data) =>
          Array.isArray(data) &&
          (data as FormSummary[]).some((form) =>
            canReviewForm(form.grantedCapabilities),
          ),
      },
    },
  ],
  routes: [
    { index: true, element: <FormsPluginPage /> },
    {
      path: "new",
      element: <CreateFormDataSourcePage />,
      handle: { breadcrumb: "Create form" },
    },
    {
      path: ":id",
      element: <FormDataSourcePage />,
      handle: { breadcrumb: "Form", resource: formResource },
    },
  ],
  standaloneRoutes: [
    {
      // The submitter portal intentionally lives outside the operator
      // sidebar with its own shell and authentication. It renders without
      // the install gate so an uninstalled plugin shows the portal's own
      // empty/error states instead of broken UI.
      path: "/forms",
      gate: "none",
      topLevel: true,
      children: [
        {
          element: <FormsPortalShell />,
          children: [
            { index: true, element: <FormsListPage /> },
            { path: ":id", element: <FormPortalDetailPage /> },
            { path: ":id/new", element: <FormPortalSubmissionPage /> },
            {
              path: ":id/submissions/:recordId",
              element: <FormPortalSubmissionPage />,
            },
          ],
        },
      ],
    },
    {
      // The reviewer inbox lives in the authenticated Studio chrome but
      // outside the plugin-management subtree. Like the portal it renders
      // without the install gate and handles that state itself.
      path: "/approvals",
      gate: "none",
      topLevel: false,
      children: [
        {
          index: true,
          element: <ApprovalsPage />,
          handle: {
            breadcrumb: "Approvals",
            search: {
              // i18n-ignore: global search entries render in English, matching the previous central definition.
              label: "Approvals",
              description:
                // i18n-ignore: global search entries render in English, matching the previous central definition.
                "Review submissions awaiting a decision across your forms",
              to: "/approvals",
              keywords: ["forms", "review", "submissions", "inbox"],
            },
          },
        },
      ],
    },
  ],
});
