FROM python:3.11-slim
WORKDIR /app
COPY scraper/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY scraper/server.py .
ENV PYTHONUNBUFFERED=1
CMD ["python", "server.py"]
