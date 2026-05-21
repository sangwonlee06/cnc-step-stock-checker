FROM node:22-alpine AS build

WORKDIR /app

COPY frontend-react/package*.json ./
RUN npm ci

COPY frontend-react ./
RUN npm run build

FROM nginx:1.27-alpine

COPY frontend-react/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY frontend-react/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
