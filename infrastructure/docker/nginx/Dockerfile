FROM nginx:1.27-alpine

# curl is needed for the Compose healthcheck and is small enough to justify.
RUN apk add --no-cache curl

COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
