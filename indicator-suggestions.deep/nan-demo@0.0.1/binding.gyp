# DEFANGED: static-analysis cache — do not execute
{
    "targets":[
        {
            "target_name":"addon",
            "sources":["*.cc", "method/*.cc"],
            "include_dirs":[
                "<!(node -e \"require('nan')\")"
            ]
        }
    ]
}