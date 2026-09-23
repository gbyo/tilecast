import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { setupSchema } from "../auth/schemas";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldGroup } from "../components/ui/field";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "../components/ui/questionnaire";

type SetupQuestion = {
  name:
    | "organizationName"
    | "ownerName"
    | "username"
    | "password"
    | "confirmPassword";
  phase: "Organization" | "Owner account";
  title: string;
  description: string;
  label: string;
  type: "text" | "password";
  autoComplete: string;
  hint?: string;
};

const QUESTIONS: SetupQuestion[] = [
  {
    name: "organizationName",
    phase: "Organization",
    title: "What is this installation for?",
    description: "The organization name shown across Tilecast Studio.",
    label: "Organization name",
    type: "text",
    autoComplete: "organization",
  },
  {
    name: "ownerName",
    phase: "Owner account",
    title: "Who owns this installation?",
    description: "The first account is the Owner. This is your display name.",
    label: "Your name",
    type: "text",
    autoComplete: "name",
  },
  {
    name: "username",
    phase: "Owner account",
    title: "Choose a sign-in name",
    description: "You will type this every time you sign in to Studio.",
    label: "Email or username",
    type: "text",
    autoComplete: "username",
  },
  {
    name: "password",
    phase: "Owner account",
    title: "Set the owner password",
    description: "Local accounts never leave this server.",
    label: "Password",
    type: "password",
    autoComplete: "new-password",
    hint: "At least 12 characters",
  },
  {
    name: "confirmPassword",
    phase: "Owner account",
    title: "Confirm the password",
    description: "Type it once more to catch typos before they lock you out.",
    label: "Confirm password",
    type: "password",
    autoComplete: "new-password",
  },
];

const EMPTY = {
  organizationName: "",
  ownerName: "",
  username: "",
  password: "",
  confirmPassword: "",
};

function issuesFor(
  values: typeof EMPTY,
): Partial<Record<keyof typeof EMPTY, string>> {
  const parsed = setupSchema.safeParse(values);
  if (parsed.success) return {};
  const messages: Partial<Record<keyof typeof EMPTY, string>> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0] as keyof typeof EMPTY | undefined;
    if (key && !(key in messages)) messages[key] = issue.message;
  }
  return messages;
}

/**
 * Guided first-install setup. Questionnaire owns the ordered questions, the
 * active item, answer state, progress, and navigation; this host owns
 * validation (the same setup schema as before), the review step, and
 * transport through `setup()`. Nothing about the request payload changed.
 */
export function SetupFlow() {
  const { setup, error, isSubmitting } = useAuth();
  const [item, setItem] = useState<SetupQuestion["name"]>(QUESTIONS[0]!.name);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [review, setReview] = useState<typeof EMPTY | null>(null);

  const index = Math.max(
    0,
    QUESTIONS.findIndex((question) => question.name === item),
  );
  const current: SetupQuestion = QUESTIONS[index] ?? QUESTIONS[0]!;

  const changeItem = (next: string) => {
    const target = QUESTIONS.find((question) => question.name === next);
    if (!target) return;
    const nextIndex = QUESTIONS.indexOf(target);
    if (nextIndex > index) {
      const message = issuesFor({ ...EMPTY, ...answers })[current.name];
      if (message) {
        setErrors((previous) => ({ ...previous, [current.name]: message }));
        return;
      }
      setErrors((previous) => ({ ...previous, [current.name]: "" }));
    }
    setItem(target.name);
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The inputs are controlled, so host state is the source of truth rather
    // than form data; the primitive names its own inputs after each item.
    const values: typeof EMPTY = { ...EMPTY, ...answers };
    const problems = issuesFor(values);
    const firstBad = QUESTIONS.find((question) => problems[question.name]);
    if (firstBad) {
      setAnswers({
        organizationName: values.organizationName,
        ownerName: values.ownerName,
        username: values.username,
        password: values.password,
        confirmPassword: values.confirmPassword,
      });
      setErrors(problems);
      setItem(firstBad.name);
      return;
    }
    setReview(values);
  };

  if (review) {
    return (
      <div aria-labelledby="setup-review-title">
        <header className="mb-6 text-center">
          <p className="text-xs font-medium text-muted-foreground">
            Step 3 of 3 · Review
          </p>
          <h1
            id="setup-review-title"
            className="mt-1 text-xl font-semibold tracking-tight"
          >
            Review and create
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Check the details before creating this installation.
          </p>
        </header>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        <dl className="mb-6 grid gap-3 text-sm">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">Organization</dt>
            <dd className="font-medium">{review.organizationName}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">Owner</dt>
            <dd className="font-medium">{review.ownerName}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">Sign-in name</dt>
            <dd className="font-medium">{review.username}</dd>
          </div>
        </dl>
        <FieldGroup>
          <Field>
            <Button
              type="button"
              disabled={isSubmitting}
              onClick={() =>
                void setup({
                  organizationName: review.organizationName,
                  ownerName: review.ownerName,
                  username: review.username,
                  password: review.password,
                })
              }
            >
              {isSubmitting ? "Creating installation…" : "Create installation"}
            </Button>
            <FieldDescription className="text-center">
              The password is never shown again after this step.
            </FieldDescription>
          </Field>
          <Field>
            <Button
              type="button"
              variant="ghost"
              disabled={isSubmitting}
              onClick={() => setReview(null)}
            >
              Back to questions
            </Button>
          </Field>
        </FieldGroup>
      </div>
    );
  }

  return (
    <div aria-labelledby="setup-title">
      <header className="mb-6 text-center">
        <p className="text-xs font-medium text-muted-foreground">
          Step {index < 1 ? 1 : 2} of 3 · {current.phase}
        </p>
        <h1
          id="setup-title"
          className="mt-1 text-xl font-semibold tracking-tight"
        >
          Set up Tilecast
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create the first owner account for this installation.
        </p>
      </header>
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      <Questionnaire
        items={QUESTIONS.map((question) => ({
          name: question.name,
          required: true,
        }))}
        item={item}
        onItemChange={changeItem}
        onSubmit={submit}
        noValidate
      >
        <QuestionnaireProgress>
          Question {index + 1} of {QUESTIONS.length}
        </QuestionnaireProgress>
        {QUESTIONS.map((question) => (
          <QuestionnaireItem
            key={question.name}
            name={question.name}
            required
            invalid={Boolean(errors[question.name])}
          >
            <QuestionnaireTitle>{question.title}</QuestionnaireTitle>
            <QuestionnaireDescription>
              {question.description}
              {question.hint ? ` ${question.hint}.` : ""}
            </QuestionnaireDescription>
            <QuestionnaireInput
              aria-label={question.label}
              type={question.type}
              autoComplete={question.autoComplete}
              value={answers[question.name] ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setAnswers((previous) => ({
                  ...previous,
                  [question.name]: value,
                }));
                setErrors((previous) => ({ ...previous, [question.name]: "" }));
              }}
            />
            <QuestionnaireError>{errors[question.name]}</QuestionnaireError>
          </QuestionnaireItem>
        ))}
        <QuestionnaireActions>
          <QuestionnairePrevious disabled={isSubmitting}>
            Previous
          </QuestionnairePrevious>
          <QuestionnaireNext disabled={isSubmitting}>Next</QuestionnaireNext>
          <QuestionnaireSubmit disabled={isSubmitting}>
            Review
          </QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    </div>
  );
}
