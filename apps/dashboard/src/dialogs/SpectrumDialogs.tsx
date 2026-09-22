import { createContext, useContext, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@react-spectrum/s2/Button";
import { ButtonGroup } from "@react-spectrum/s2/ButtonGroup";
import { Content, Footer } from "@react-spectrum/s2/Dialog";
import { Dialog, DialogContainer } from "@react-spectrum/s2/Dialog";
import { Form } from "@react-spectrum/s2/Form";
import { Heading } from "@react-spectrum/s2/Heading";
import { Text } from "@react-spectrum/s2/Text";
import { TextField } from "@react-spectrum/s2/TextField";

export type ConfirmationOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  tone?: "normal" | "negative";
};

export type PromptOptions = {
  title: string;
  description?: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  type?: "text" | "password" | "number";
};

type DialogRequest =
  | ({ kind: "confirm" } & ConfirmationOptions)
  | ({ kind: "prompt" } & PromptOptions);

type SpectrumDialogApi = {
  confirm: (options: ConfirmationOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
};

const SpectrumDialogContext = createContext<SpectrumDialogApi | null>(null);

export function useSpectrumDialogs() {
  const context = useContext(SpectrumDialogContext);
  if (!context) {
    throw new Error("useSpectrumDialogs must be used inside SpectrumDialogsProvider.");
  }
  return context;
}

export function SpectrumDialogsProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<DialogRequest>();
  const [promptValue, setPromptValue] = useState("");
  const resolver = useRef<((value: boolean | string | null) => void) | null>(null);

  const confirm = (options: ConfirmationOptions) =>
    new Promise<boolean>((resolve) => {
      resolver.current = (value) => resolve(value === true);
      setRequest({ kind: "confirm", ...options });
    });

  const prompt = (options: PromptOptions) =>
    new Promise<string | null>((resolve) => {
      resolver.current = (value) => resolve(typeof value === "string" ? value : null);
      setPromptValue(options.defaultValue ?? "");
      setRequest({ kind: "prompt", ...options });
    });

  const finish = (value: boolean | string | null) => {
    resolver.current?.(value);
    resolver.current = null;
    setRequest(undefined);
  };

  const submitPrompt = (event: FormEvent) => {
    event.preventDefault();
    finish(promptValue);
  };

  return (
    <SpectrumDialogContext.Provider value={{ confirm, prompt }}>
      {children}
      <DialogContainer onDismiss={() => finish(null)}>
        {request && (
          <Dialog aria-label={request.title} size="S" isDismissible>
            <Heading slot="title">{request.title}</Heading>
            <Content>
              {request.description && <Text>{request.description}</Text>}
              {request.kind === "prompt" && (
                <Form onSubmit={submitPrompt} validationBehavior="aria">
                  <TextField
                    autoFocus
                    label={request.label}
                    value={promptValue}
                    placeholder={request.placeholder}
                    type={request.type ?? "text"}
                    onChange={setPromptValue}
                  />
                  <Footer>
                    <ButtonGroup>
                      <Button variant="secondary" onPress={() => finish(null)}>
                        Cancel
                      </Button>
                      <Button type="submit" variant="accent">
                        {request.confirmLabel ?? "Continue"}
                      </Button>
                    </ButtonGroup>
                  </Footer>
                </Form>
              )}
            </Content>
            {request.kind === "confirm" && (
              <Footer>
                <ButtonGroup>
                  <Button variant="secondary" onPress={() => finish(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant={request.tone === "negative" ? "negative" : "accent"}
                    onPress={() => finish(true)}
                  >
                    {request.confirmLabel ?? "Continue"}
                  </Button>
                </ButtonGroup>
              </Footer>
            )}
          </Dialog>
        )}
      </DialogContainer>
    </SpectrumDialogContext.Provider>
  );
}
