# A sealed text span becomes an image only when it fills a page

The Fill Gate lets a sealed text span become a microfiche image only when it fills most of a page's capacity, as resolved from the provider's geometry and image cap; a span that would leave most of the frame blank stays text. Image tokens spend from the same raw bucket as text — two 4k-token images plus 20k raw text consume 28k of a 30k bucket — so an underfilled image buys little coverage for its full token cost, which is why Microfiche policy runs a memory update instead of adding the image whenever the next image would not fill its page or would not fit the bucket.

## Considered Options

- **Image a span regardless of fill** — rejected: every underfilled frame spends its full image token cost from the same bucket while replacing little raw text.
