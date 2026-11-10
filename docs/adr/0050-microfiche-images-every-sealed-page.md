# Microfiche images every sealed page with no fill minimum

Sealed Microfiche pages image 1:1 in order with no minimum-fill holdback: a page ships as an image the moment pagination emits it, and a page stays text only when image-cap slots run out or frames-times-frame-cost plus leftover text overflows the shared raw bucket, in which case the waiter requests a memory update (ADR-0046). The trailing-page 0.75 holdback only delayed saving: an underfilled frame still replaces its text, and chat growth alone promotes it without a run, while cap plus bucket already bound cost.

## Considered Options

- **Hold the trailing partial page as text until three-quarters full** — rejected: covered text kept billing as text while waiting on growth that might never fill the frame.
