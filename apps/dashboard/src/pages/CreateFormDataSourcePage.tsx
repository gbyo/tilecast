import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { canManageContent } from "./ContentPage";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";

// CreateFormDataSourcePage collects the form name/description and the initial form
// title/description, then creates the Form (which the server publishes as its first revision) and
// navigates to the new form's builder.
export function CreateFormDataSourcePage() {
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [error, setError] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createForm(
        {
          name: name.trim(),
          description: description.trim(),
          draftSchema: {
            title: formTitle.trim(),
            description: formDescription.trim(),
            fields: [
              {
                key: "title",
                label: "Title",
                control: "short_text",
                required: true,
              },
            ],
          },
        },
        csrf,
      ),
    onMutate: () => setError(""),
    onSuccess: (form) => {
      void queryClient.invalidateQueries({ queryKey: ["forms"] });
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      void navigate(`/plugins/forms/${form.id}?tab=form`);
    },
    onError: (err) =>
      setError(
        err instanceof Error ? err.message : "Could not create the form.",
      ),
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (create.isPending) {
      return;
    }
    if (name.trim() === "") {
      setError("A name is required.");
      return;
    }
    create.mutate();
  };

  if (!canManageContent(auth.status?.user)) {
    return (
      <section className="mx-auto grid w-full max-w-2xl gap-4 px-4 py-6 sm:px-6">
        <Alert variant="destructive">
          <AlertTitle>Insufficient access</AlertTitle>
          <AlertDescription>
            You do not have permission to create forms.
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  return (
    <section className="mx-auto grid w-full max-w-2xl gap-4 px-4 py-6 sm:px-6">
      <header className="grid gap-1">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Forms plugin
        </p>
        <h1 className="text-xl font-semibold tracking-tight">Create a Form</h1>
        <p className="text-sm text-muted-foreground">
          Collect submissions, approve them, and publish records to Widgets.
        </p>
      </header>
      <form
        className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:p-5"
        onSubmit={submit}
      >
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Could not create form</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="create-form-name">Form name</FieldLabel>
          <Input
            id="create-form-name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Staff Announcements"
          />
          <FieldDescription>
            Shown in the Forms plugin and when selecting form output in Widgets.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="create-form-description">
            Form description
          </FieldLabel>
          <Textarea
            id="create-form-description"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="create-form-title">Form title</FieldLabel>
          <Input
            id="create-form-title"
            value={formTitle}
            onChange={(event) => setFormTitle(event.target.value)}
          />
          <FieldDescription>
            Shown above the form to submitters.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="create-form-schema-description">
            Form description
          </FieldLabel>
          <Textarea
            id="create-form-schema-description"
            rows={2}
            value={formDescription}
            onChange={(event) => setFormDescription(event.target.value)}
          />
        </Field>
        <Alert>
          <AlertTitle>A starter field is included</AlertTitle>
          <AlertDescription>
            Your form starts with a required “Title” field and is published
            immediately. You can add fields and publish new revisions from the
            builder.
          </AlertDescription>
        </Alert>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => void navigate("/plugins/forms")}
          >
            Back
          </Button>
          <Button
            type="submit"
            variant="default"
            disabled={name.trim() === "" || create.isPending}
          >
            {create.isPending && <Spinner aria-hidden="true" />}
            Create form
          </Button>
        </div>
      </form>
    </section>
  );
}
