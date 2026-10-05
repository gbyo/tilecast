# Accessibility

Tilecast is open-source digital signage infrastructure. The people who deploy signage, manage screens, create content, maintain installations, and contribute to the project should be able to use Tilecast regardless of disability, input method, or assistive technology.

Accessibility applies to the whole Tilecast experience: Studio, documentation, the iPhone and iPad app, Player setup and maintenance interfaces, built-in Widgets and plugins, and the content-authoring tools used to put information on screens.

This document describes the accessibility outcomes Tilecast works toward, what we expect from contributors, how to report a barrier, and the limits of what we currently test.

## Priorities

Tilecast works toward **WCAG 2.2 Level AA** for user-facing software and documentation where the guidelines apply. This is a development target, not a claim that Tilecast has been independently evaluated or fully conforms to WCAG 2.2 AA.

We prioritize:

- **Keyboard and non-pointer access.** Core Studio tasks should not require a mouse. Interactive controls need a logical focus order, visible focus state, and expected keyboard behavior.
- **Screen reader support.** Interfaces should use native semantics where possible and provide useful names, descriptions, states, headings, and announcements where native semantics are not enough.
- **Clear visual communication.** Color, position, animation, or an icon alone should not be the only way important status or meaning is communicated.
- **Readable and adaptable interfaces.** Text should remain readable with increased zoom or text size, and interfaces should continue to work at narrow viewport sizes without hiding required actions.
- **Reduced motion.** Management interfaces, previews, Widgets, and other animated experiences should respect reduced-motion preferences where a user preference is available. Essential information must not depend on motion.
- **Accessible content authoring.** Tilecast should help people create signage that remains understandable to as many viewers as possible rather than encouraging inaccessible defaults.
- **Localization.** User-facing text belongs in Tilecast's localization system. English, Spanish, and Russian are currently shipped, and language metadata and translated labels should remain usable by assistive technology.
- **Consistent interaction patterns.** Prefer established Tilecast design-system components and platform-native controls over custom interaction models when they provide the required behavior.

Accessibility is part of product quality. It is not something that should be deferred until after a feature is otherwise considered complete.

## Contributor expectations

User-facing changes should preserve or improve accessibility.

### Interface changes

When adding or changing interactive UI:

- Prefer semantic HTML and native platform controls.
- Use Tilecast's shared UI primitives instead of recreating buttons, dialogs, menus, tabs, form fields, drawers, or other common controls without a reason.
- Give icon-only controls an accessible name.
- Associate form labels, descriptions, validation messages, and errors with the fields they describe.
- Do not use clickable `div` or `span` elements where a button, link, or another semantic control is appropriate.
- Keep heading structure and landmarks meaningful.
- Expose state such as selected, expanded, checked, busy, invalid, or current when it is relevant to the interaction.
- Make status changes and important asynchronous results understandable without requiring the user to notice a visual change.
- Do not communicate health, severity, success, failure, or another important state using color alone.
- Preserve visible focus indicators.
- Avoid keyboard traps in dialogs, menus, popovers, drawers, editors, and other layered interfaces.
- Honor reduced-motion preferences for non-essential movement.

Complex interfaces such as layout editors, charts, drag-and-drop tools, previews, and visual content editors deserve particular attention. A visual interaction should have a practical non-pointer path whenever it is required to complete a core task.

### Manual testing

For meaningful user-facing changes, perform the checks that apply to the change:

- Complete the changed interaction using only a keyboard.
- Confirm focus moves predictably and remains visible.
- Check the interface at increased browser zoom and at a narrow viewport.
- Check light and dark appearances when the component supports both.
- Enable reduced motion when animation is involved.
- Spot-check a screen reader when introducing a new interaction pattern, complex control, or native iOS experience.
- On television interfaces, verify the experience with the intended remote or directional input.

Screenshots and visual regression tests are useful, but they do not prove that an interface is accessible.

### Tests and CI

Add or update automated tests when accessibility behavior can be represented reliably in the existing test suite. Prefer assertions based on accessible roles, names, state, and user-visible behavior over implementation details.

Tilecast's existing validation includes component tests, real-application Playwright journeys, visual regression testing, localization checks, and platform-specific tests. Studio's committed browser and visual baselines currently run in Chromium.

Run the repository's normal validation before opening a pull request:

```sh
make format
make check
```

For relevant Studio changes, also run the appropriate browser or visual tests described in [`docs/testing.md`](docs/testing.md).

Tilecast does **not currently have a dedicated automated accessibility scanner as a required CI gate**. Contributors should not treat a passing CI run or visual comparison as accessibility certification.

### Documentation and content

Documentation changes should:

- Use a logical heading structure.
- Use descriptive link text rather than phrases such as "click here."
- Provide useful alternative text for informative images.
- Treat decorative images as decorative rather than giving them redundant descriptions.
- Provide a text explanation for diagrams when the information cannot be understood from surrounding text.
- Provide captions or an equivalent text alternative for instructional video when practical.
- Avoid relying on screenshots alone to explain a procedure.
- Avoid using color alone to distinguish states or instructions.

When a feature is translated, accessibility labels, descriptions, status text, and other assistive text must be localized along with visible text.

## Reporting accessibility issues

If Tilecast prevents you from completing a task or makes a task unnecessarily difficult because of an accessibility barrier, please report it.

Open a [UI/UX issue](https://github.com/gbyo/tilecast/issues/new?template=ui_ux_issue.yml) or a regular [GitHub issue](https://github.com/gbyo/tilecast/issues/new).

Include whatever information you are comfortable providing. Helpful details include:

- What you were trying to do.
- Which part of Tilecast was affected: Studio, documentation, iOS, a Player, a Widget, or another surface.
- The page or screen where the problem occurred.
- What happened and what you expected instead.
- Steps that reproduce the problem.
- Your browser, operating system, device, or Tilecast version when relevant.
- The input method or assistive technology involved, if relevant.
- Whether you found a workaround.

Screenshots or recordings can be helpful but are **not required**.

You do not need to disclose a disability, diagnosis, or other personal information to report an accessibility problem.

### Severity

Reporters do not need to choose a severity. Maintainers can determine priority during triage based on how much the barrier affects the task.

As a general guide:

- **Critical:** A core task cannot be completed and there is no reasonable accessible alternative.
- **Serious:** A core task is technically possible but requires a substantial workaround or creates a major barrier.
- **Moderate:** The task remains usable but is significantly harder, confusing, or inconsistent for some users.
- **Minor:** The issue has limited impact but still creates unnecessary friction or reduces accessibility quality.

A problem can be important even if it affects a small number of people.

### How we respond

Accessibility reports should be handled like other product bugs, with additional attention to whether the affected task has an accessible alternative.

Maintainers will:

- Treat the reported barrier as a product issue rather than requiring the reporter to justify their accessibility needs.
- Reproduce and document the affected user experience when possible.
- Identify a workaround when one is available.
- Prioritize barriers according to their effect on completing the task.
- Keep the issue updated when its status meaningfully changes.
- Avoid closing a report solely because an automated test passes.
- Invite the reporter to verify a fix when that would be useful and they are willing to do so.

Tilecast does not currently promise fixed resolution times for accessibility issues. Critical barriers to core workflows should be treated as release-blocking when practical.

## Ownership and maintenance

Accessibility is a shared responsibility of the Tilecast maintainers and contributors.

Maintainers are responsible for:

- Triaging accessibility reports.
- Preventing known accessibility regressions from being introduced intentionally.
- Tracking significant known barriers.
- Keeping shared UI primitives and design guidance accessible.
- Making accessibility part of review for significant user-facing work.
- Keeping this document consistent with the project's actual testing and support.

This statement should be reviewed when Tilecast adds a major new user-facing platform or interaction model, when accessibility testing changes materially, and before stable releases when practical.

If project ownership changes, accessibility ownership follows the maintainers responsible for the affected part of Tilecast.

## Supported environments

Tilecast spans several different environments, and accessibility testing is not identical across them.

### Studio and documentation

Studio is a web application and the documentation site is web-based.

Tilecast's automated end-to-end and committed visual regression tests currently use **Chromium on Linux**. Modern standards-based browsers are expected to work, but Chromium is currently the browser covered by the project's primary automated browser compatibility evidence.

Relevant input methods include:

- Keyboard
- Pointer or trackpad
- Touch on responsive interfaces

There is not currently a formal, continuously tested browser-and-screen-reader compatibility matrix for Studio.

### iPhone and iPad

The Tilecast app currently targets **iOS and iPadOS 26**.

Native interfaces should follow Apple platform accessibility behavior and support system settings such as text sizing and reduced motion where applicable. Studio content embedded in the app remains responsible for its web accessibility as well.

The project does not currently claim complete VoiceOver coverage across every Studio and native workflow.

### Android Player

Tilecast Player supports Android TV, Google TV, and Fire TV devices that can install the Tilecast APK.

Player setup and maintenance interfaces should remain understandable and operable with the intended television remote or directional input.

A complete TalkBack compatibility matrix is not currently maintained.

### Linux Player and Tilecast Edge

The current production Linux Player targets 64-bit x86_64 Linux systems with a graphical X11 or Wayland session.

Tilecast Edge is the next Linux Player architecture and remains a preview until its supported hardware is qualified.

Player playback is primarily presentation output rather than a conventional interactive application. Where Player setup, recovery, or maintenance controls are interactive, those controls should still use clear text, focus, and input behavior.

## Known limitations

Tilecast's accessibility work is ongoing.

Current limitations in our accessibility assurance include:

- Tilecast has not undergone a complete independent WCAG 2.2 accessibility audit, so this document does not make a conformance claim.
- Required CI does not currently include a dedicated automated accessibility scanner.
- Chromium is the primary browser used for automated Studio end-to-end and visual testing; Firefox and Safari are not part of the same continuous browser test matrix.
- The project does not currently maintain complete VoiceOver, NVDA, JAWS, or TalkBack test matrices.
- Player setup and maintenance experiences have not been formally evaluated across every supported device and assistive-technology combination.
- Content displayed by Tilecast can include uploaded media, websites, custom Widgets, plugins, and material created by an administrator. Tilecast cannot guarantee the accessibility of third-party or user-authored content.

These limitations should not be interpreted as acceptable reasons to leave a known barrier unfixed.

If you encounter a specific barrier, please report it even if the affected combination is not listed as formally tested.

## Feedback and improvements

Accessibility is an ongoing engineering and design practice.

If you have an idea for improving Tilecast's accessibility practices, testing, documentation, or this statement, open an issue or pull request.

For a barrier that is actively preventing you from using Tilecast, use the reporting process above so it can be tracked and addressed directly.

Thank you for helping make Tilecast usable by more people.
