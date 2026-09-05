---
name: retrieval-augmented-generation
description: "Retrieval augmented generation: what it is, what it fixes, and where it quietly fails."
type: wiki-concept
audience: [public]
created: 2026-01-22
---

A model answers from what it was given, so the useful question is what to give it. Retrieval
augmented generation puts a search in front of the model: the question retrieves passages, the
passages go into the prompt, the answer is grounded in them.

What it fixes: knowledge that changes after training, and citations. What it does not fix: a
retriever that returns the wrong passage confidently, which produces a fluent answer with a
source attached, and is harder to spot than an admission of ignorance.

So the measurement that matters is the retrieval one — whether the passage that answers the
question is in the top few — and it has to be taken on the corpus that will actually be searched.
Related: [[measure-before-optimizing]].
