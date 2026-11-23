---
name: jsdoc-summary-paragraph
subject: The first paragraph of JSDoc comments.
requirement: Each JSDoc comment opens with one standalone summary paragraph that
  says what the symbol is or does and states the sharpest caller-visible fact
  the signature cannot show. Functions start with a present-tense verb such as
  `Creates`, `Returns`, `Parses`, or `Provides`; values start with a consistent
  noun phrase such as `Layer that`, `Schema for`, or `Service that`. The
  paragraph uses the plain domain phrase someone would search for when it
  differs from the identifier.
purpose: Makes the comment understandable and findable from its first line.
---
Example: `Parses an email address received at an external input boundary.`