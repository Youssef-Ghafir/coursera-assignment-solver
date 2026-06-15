(function () {
    const originalFetch = window.fetch;
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    class InterceptBus {
        send(url, contentType, responseData, requestData) {
            window.postMessage({
                source: "auto-coursera-interceptor",
                url: url,
                contentType: contentType,
                response: responseData,
                request: requestData
            }, window.location.origin);
        }
    }
    const messageBus = new InterceptBus();

    window.fetch = async function (resource, initParams) {
        try {
            const response = await originalFetch.apply(this, arguments);

            // We must clone the response before reading it, so the original stream isn't consumed
            const responseClone = response.clone();
            const url = responseClone.url;
            const contentType = responseClone.headers.get("content-type") || "";

            let responseBody;
            if (contentType.includes("application/json") && url.includes("/api/")) {
                try {
                    responseBody = await responseClone.json();
                } catch (_) {}
            }

            const requestData = {
                url: url,
                method: initParams?.method || "GET",
                headers: initParams?.headers ? Array.from(new Headers(initParams.headers).entries()) : [],
                body: initParams?.body,
                status: responseClone.status,
                statusText: responseClone.statusText
            };

            messageBus.send(url, contentType, responseBody, requestData);

            return response;
        } catch (error) {
            throw error;
        }
    };

    XMLHttpRequest.prototype.open = function (method, url) {
        this._interceptUrl = url;
        this._interceptMethod = method;
        this._interceptHeaders = [];
        return originalXHROpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        this._interceptHeaders.push([name, value]);
        return originalXHRSetRequestHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
        this.addEventListener('load', function () {
            const url = this.responseURL || this._interceptUrl;
            const contentType = this.getResponseHeader('content-type') || "";
            let responseData;
            
            if (contentType.includes("application/json") && url.includes("/api/")) {
                try {
                    responseData = JSON.parse(this.responseText);
                } catch(e) {}
            }

            const requestData = {
                url: url,
                method: this._interceptMethod,
                headers: this._interceptHeaders, 
                body: body,
                status: this.status,
                statusText: this.statusText
            };

            messageBus.send(url, contentType, responseData, requestData);
        });

        return originalXHRSend.apply(this, arguments);
    };
    
})();
