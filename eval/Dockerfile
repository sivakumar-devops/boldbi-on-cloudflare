FROM syncfusion/boldbi:17.1.30-eval@sha256:6fbd761245b51c060eba5db783885304a6af3e2a19e74039ff3aa74632c723f9

# Keep the vendor's bundled PostgreSQL 15 and BoldBI entrypoint.
COPY cloudflare-entrypoint.sh /usr/local/bin/boldbi-eval-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/boldbi-eval-entrypoint && chmod 755 /usr/local/bin/boldbi-eval-entrypoint
WORKDIR /application
ENTRYPOINT ["/usr/local/bin/boldbi-eval-entrypoint"]
CMD ["/application/entrypoint.sh"]
EXPOSE 80
