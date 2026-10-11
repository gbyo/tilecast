import { css } from "lit";

export const eventScrollerStyles = css`
  .board {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    padding: var(--tc-gutter);
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    --row-size: clamp(44px, min(15cqh, 12cqw), 180px);
    --row-gap: clamp(8px, 2cqmin, 32px);
    --axis: tc-events-up;
    --reverse: normal;
    --track-flow: column;
    --group-display: grid;
    --group-block: 100cqh;
    --group-inline: 100%;
    --track-inline: 100%;
    --row-font: clamp(12px, min(5cqh, 3.1cqw), 72px);
  }
  .board[data-density="compact"] {
    --row-size: clamp(36px, min(11cqh, 10cqw), 130px);
  }
  .board[data-density="spacious"] {
    --row-size: clamp(52px, min(19cqh, 16cqw), 230px);
  }
  .heading {
    flex: none;
    font-size: clamp(14px, min(6cqh, 4cqw), 100px);
    font-weight: 650;
    letter-spacing: -0.025em;
    line-height: 1.15;
    margin-bottom: min(3cqh, 3cqw);
    padding-bottom: min(2cqh, 2cqw);
    border-bottom: var(--tc-stroke) solid var(--tc-color-accent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The viewport supplies the movement-axis minimum after the fixed heading. */
  .viewport {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    container-type: size;
  }
  .track {
    display: flex;
    flex-direction: var(--track-flow);
    width: var(--track-inline);
    animation: var(--axis) var(--tc-event-seconds) linear infinite;
    animation-direction: var(--reverse);
    will-change: transform;
  }
  .group {
    display: var(--group-display);
    grid-template-columns: minmax(0, 1fr);
    grid-auto-rows: minmax(var(--row-size), 1fr);
    flex: none;
    min-block-size: var(--group-block);
    min-inline-size: var(--group-inline);
    align-items: stretch;
    justify-content: space-around;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--row-gap);
    min-width: 0;
    padding-block: 0.5em;
    box-sizing: border-box;
    font-size: var(--row-font);
    line-height: 1.2;
  }
  .board[data-dividers] .row {
    border-bottom: var(--tc-stroke) solid var(--tc-color-separator);
  }
  .date,
  .time,
  .location,
  .category,
  .title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .date {
    flex: 0 0 19%;
    font-size: 0.7em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.035em;
    color: var(--tc-color-accent);
  }
  .title {
    flex: 1;
    min-width: 0;
    font-weight: 580;
    letter-spacing: -0.02em;
  }
  .time {
    flex: 0 0 14%;
    text-align: end;
    font-size: 0.85em;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .location,
  .category {
    flex: 0 1 18%;
    font-size: 0.65em;
    color: var(--tc-color-fg-muted);
  }
  .category {
    flex-basis: 10%;
  }
  .separator {
    display: none;
  }
  .board[data-vertical-direction="down"] {
    --reverse: reverse;
  }
  .board[data-flow="horizontal"] {
    --axis: tc-events-left;
    --track-flow: row;
    --group-display: flex;
    --group-inline: 100cqw;
    --track-inline: max-content;
    --reverse: var(--tc-event-horizontal-reverse);
    --row-font: clamp(14px, min(22cqh, 3.1cqw), 64px);
  }
  @container tc-widget (aspect-ratio > 4) and (max-height: 360px) {
    .board[data-flow="auto"] {
      --axis: tc-events-left;
      --track-flow: row;
      --group-display: flex;
      --group-inline: 100cqw;
      --track-inline: max-content;
      --reverse: var(--tc-event-horizontal-reverse);
      --row-font: clamp(14px, min(22cqh, 3.1cqw), 64px);
    }
  }
  .board[data-flow="horizontal"] .row {
    flex: none;
    gap: 0.6em;
    padding-inline-end: 1.5em;
    border: 0;
  }
  .board[data-flow="horizontal"] .date,
  .board[data-flow="horizontal"] .time {
    flex: none;
  }
  .board[data-flow="horizontal"] .title {
    flex: none;
    max-width: min(70cqw, 32em);
  }
  .board[data-flow="horizontal"] .separator {
    display: block;
    color: var(--tc-color-accent);
    padding-inline-start: 0.8em;
  }
  .board[data-flow="horizontal"] .location,
  .board[data-flow="horizontal"] .category {
    display: none;
  }
  @container tc-widget (aspect-ratio > 4) and (max-height: 360px) {
    .board[data-flow="auto"] .row {
      flex: none;
      gap: 0.6em;
      padding-inline-end: 1.5em;
      border: 0;
    }
    .board[data-flow="auto"] .date,
    .board[data-flow="auto"] .time {
      flex: none;
    }
    .board[data-flow="auto"] .title {
      flex: none;
      max-width: min(70cqw, 32em);
    }
    .board[data-flow="auto"] .separator {
      display: block;
      color: var(--tc-color-accent);
      padding-inline-start: 0.8em;
    }
    .board[data-flow="auto"] .location,
    .board[data-flow="auto"] .category {
      display: none;
    }
    .heading {
      font-size: clamp(12px, 14cqh, 50px);
      margin-bottom: 2cqh;
      padding-bottom: 2cqh;
    }
  }
  @container tc-widget (max-width: 1100px) {
    .location {
      display: none;
    }
  }
  @container tc-widget (max-width: 700px) {
    .category {
      display: none;
    }
    .date {
      flex-basis: 25%;
      font-size: 0.75em;
    }
    .time {
      flex-basis: 20%;
    }
    .board[data-flow="vertical"],
    .board[data-flow="auto"] {
      --row-font: clamp(12px, min(6cqh, 5cqw), 32px);
    }
  }
  @container tc-widget (max-width: 300px) {
    .date {
      display: none;
    }
    .time {
      flex-basis: 28%;
    }
  }
  .board[data-still] .track {
    animation: none;
    transform: none;
    will-change: auto;
  }
  @media (prefers-reduced-motion: reduce) {
    .track {
      animation: none;
      transform: none;
      will-change: auto;
    }
    .group[aria-hidden="true"] {
      display: none;
    }
  }
  @keyframes tc-events-up {
    to {
      transform: translateY(-50%);
    }
  }
  @keyframes tc-events-left {
    to {
      transform: translateX(-50%);
    }
  }
`;
