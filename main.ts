import { InferenceClient } from "@digitalocean/dots";

const client = new InferenceClient({
    apiKey: process.env.DIGITALOCEAN_TOKEN,
});

const resp = await client.messages.create({
    model: "gpt-oss-120b",
    max_tokens: 1024,
    messages: [
        { role: "user", content: "What is the capital of Portugal?" },
    ],
});

console.log(resp.content[0].text);
